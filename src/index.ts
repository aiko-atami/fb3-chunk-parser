import * as fs from 'fs/promises';
import { DEFAULT_DELAY_MS, delay, fetchJsObject, loadCookies, requireValue, saveCookies } from './common.ts';

// ─── Config ───────────────────────────────────────────────────────────────────

// Target book identifiers — provided via .env
const BOOK_ID = requireValue(process.env.BOOK_ID, 'BOOK_ID');
const VERSION_ID = requireValue(process.env.VERSION_ID, 'VERSION_ID');
const BASE_URL = requireValue(process.env.BASE_URL, 'BASE_URL');

// Construct full endpoint URL dynamically
const ENDPOINT_URL = `${BASE_URL}${BOOK_ID}/${VERSION_ID}/json/`;

// Delay between chunk requests to avoid rate-limiting (ms).
const DELAY_MS = DEFAULT_DELAY_MS;

// Output directory: book_<id>/
const OUT_DIR = `book_${BOOK_ID}`;

// ─── Text Extraction ──────────────────────────────────────────────────────────

/**
 * Recursively extracts plain text from an array of inline content items.
 * Strips soft-hyphens (U+00AD) inserted by the server for browser hyphenation.
 * Pure function.
 */
function extractInline(items: unknown[]): string {
    let out = '';
    for (const item of items) {
        if (typeof item === 'string') {
            out += item;
        } else if (typeof item === 'object' && item !== null) {
            const node = item as Record<string, unknown>;
            if (Array.isArray(node['c'])) {
                out += extractInline(node['c'] as unknown[]);
            }
        }
    }
    return out.replace(/\xad/g, '');
}

/**
 * A token is either a chapter heading or a body paragraph.
 * Using a flat token stream instead of nesting makes cross-chunk chapter
 * accumulation trivial: just scan the token list in order.
 */
type Token =
    | { kind: 'heading'; text: string }
    | { kind: 'para'; text: string };

/**
 * Converts a raw content chunk (array of nodes) into a flat list of tokens.
 *
 * Node types handled:
 *   - "p"       → para token; c = string[]
 *   - "title"   → heading token; c = p-node[]
 *   - "section" / "body" → generic container; recurse
 *
 * Everything else (images, footnote anchors, etc.) is ignored.
 * Pure function.
 */
function extractTokens(nodes: unknown[]): Token[] {
    const tokens: Token[] = [];

    for (const node of nodes) {
        if (typeof node !== 'object' || node === null) continue;
        const n = node as Record<string, unknown>;
        const t = n['t'] as string | undefined;
        const c = n['c'];

        if (t === 'p' && Array.isArray(c)) {
            const text = extractInline(c);
            if (text) tokens.push({ kind: 'para', text });

        } else if (t === 'title' && Array.isArray(c)) {
            const lines: string[] = [];
            for (const child of c) {
                if (typeof child !== 'object' || child === null) continue;
                const ch = child as Record<string, unknown>;
                if (Array.isArray(ch['c'])) {
                    lines.push(extractInline(ch['c'] as unknown[]));
                }
            }
            const heading = lines.join(' ').trim();
            if (heading) tokens.push({ kind: 'heading', text: heading });

        } else if ((t === 'section' || t === 'body') && Array.isArray(c)) {
            tokens.push(...extractTokens(c as unknown[]));
        }
    }

    return tokens;
}

// ─── TOC types ────────────────────────────────────────────────────────────────

interface TocPart {
    s: number;
    e: number;
    url: string;
}

interface Toc {
    Meta: { Title: string; UUID: string };
    full_length: number;
    Parts: TocPart[];
}

// ─── Chapter accumulation ─────────────────────────────────────────────────────

interface Chapter {
    title: string;  // '' for content before the first heading
    paras: string[];
}

/**
 * Feeds a token stream into the running chapter list.
 * Creates a new Chapter object on each heading to avoid shared-reference bugs.
 * Returns the updated `current` chapter (may be a new object).
 * Side-effectful: appends completed chapters to `chapters`.
 */
function feedTokens(
    tokens: Token[],
    chapters: Chapter[],
    current: Chapter,
): Chapter {
    for (const token of tokens) {
        if (token.kind === 'heading') {
            // Snapshot completed chapter (copy, not reference) and flush.
            chapters.push({ title: current.title, paras: [...current.paras] });
            // Start a fresh object for the new chapter.
            current = { title: token.text, paras: [] };
        } else {
            current.paras.push(token.text);
        }
    }
    return current;
}

// ─── Slug ─────────────────────────────────────────────────────────────────────

/**
 * Converts a chapter heading into a safe filename fragment.
 * Preserves ASCII word characters and Cyrillic letters; replaces spaces with '_'.
 * Pure function.
 */
function slugify(str: string): string {
    return str
        .replace(/[^\wа-яА-ЯёЁ\s]/g, '')
        .trim()
        .replace(/\s+/g, '_')
        .slice(0, 60);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
    // 1. Load auth cookies from disk (fail fast if missing).
    let cookies = await loadCookies();

    // 2. Fetch the Table of Contents.
    const tocUrl = `${ENDPOINT_URL}toc.js?cachev=${Date.now()}`;
    console.log(`Fetching TOC: ${tocUrl}`);

    const tocResult = await fetchJsObject(tocUrl, cookies);
    cookies = tocResult.cookies;
    await saveCookies(cookies);

    const toc = tocResult.data as Toc;
    if (!toc || !Array.isArray(toc.Parts) || toc.Parts.length === 0) {
        throw new Error('Invalid or empty TOC structure');
    }

    const bookTitle = toc.Meta?.Title ?? `Book ${BOOK_ID}`;
    console.log(`Book: "${bookTitle}" — ${toc.Parts.length} chunks`);

    // 3. Stream all chunks and accumulate tokens into chapters.
    //    `current` is the chapter currently being filled; it is flushed to
    //    `chapters` whenever a new heading token arrives.
    const chapters: Chapter[] = [];
    let current: Chapter = { title: '', paras: [] };

    for (const [i, part] of toc.Parts.entries()) {
        const chunkUrl = `${ENDPOINT_URL}${part.url}`;
        const chunkResult = await fetchJsObject(chunkUrl, cookies);
        cookies = chunkResult.cookies;

        const chunkData = chunkResult.data;
        if (!Array.isArray(chunkData)) {
            throw new Error(`Unexpected chunk format for ${part.url}: ${typeof chunkData}`);
        }

        const tokens = extractTokens(chunkData);
        current = feedTokens(tokens, chapters, current);

        process.stdout.write(`  [${i + 1}/${toc.Parts.length}] ${part.url}\r`);

        await saveCookies(cookies);
        if (i < toc.Parts.length - 1) await delay(DELAY_MS);
    }

    // Flush the last open chapter (always a fresh copy — current is already
    // a standalone object after the last feedTokens call, but copy for clarity).
    chapters.push({ title: current.title, paras: [...current.paras] });

    // Drop completely empty segments (no heading and no paragraphs).
    const valid = chapters.filter(ch => ch.title || ch.paras.length > 0);

    // 4. Write output folder.
    await fs.mkdir(OUT_DIR, { recursive: true });

    const indexLines: string[] = [`# ${bookTitle}\n`];

    for (const [i, chapter] of valid.entries()) {
        const num = String(i + 1).padStart(3, '0');
        const slug = chapter.title ? slugify(chapter.title) : 'nachalo';
        const filename = `${num}_${slug}.md`;
        const filepath = `${OUT_DIR}/${filename}`;

        // Chapter file: heading (if any) + paragraphs separated by single newline.
        let content = '';
        if (chapter.title) content += `# ${chapter.title}\n\n`;
        content += chapter.paras.join('\n');

        await fs.writeFile(filepath, content, 'utf8');

        // Index entry only for named chapters.
        if (chapter.title) {
            indexLines.push(`${num}. [${chapter.title}](./${filename})`);
        }
    }

    // 5. Write index.md.
    await fs.writeFile(`${OUT_DIR}/index.md`, indexLines.join('\n') + '\n', 'utf8');

    console.log(`\nDone. ${valid.length} chapters → ${OUT_DIR}/`);
}

run().catch(err => {
    console.error('\nFatal error:', err);
    process.exit(1);
});
