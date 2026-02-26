import * as fs from 'fs/promises';

// ─── Config ───────────────────────────────────────────────────────────────────

// Target book identifiers — provided via .env
const BOOK_ID = process.env.BOOK_ID;
const VERSION_ID = process.env.VERSION_ID;
const BASE_URL = process.env.BASE_URL;

if (!BOOK_ID) throw new Error('Environment variable BOOK_ID is not set');
if (!VERSION_ID) throw new Error('Environment variable VERSION_ID is not set');
if (!BASE_URL) throw new Error('Environment variable BASE_URL is not set');

// Construct full endpoint URL dynamically
const ENDPOINT_URL = `${BASE_URL}${BOOK_ID}/${VERSION_ID}/json/`;

// Delay between chunk requests to avoid rate-limiting (ms).
const DELAY_MS = 500;

// Cookies are read from and written back to this file (excluded from git).
const COOKIES_FILE = 'cookies.txt';

// Output directory: book_<id>/
const OUT_DIR = `book_${BOOK_ID}`;

// ─── Cookie I/O ───────────────────────────────────────────────────────────────

/**
 * Reads the cookie string from disk.
 * Fails fast if the file is missing or empty.
 */
async function loadCookies(): Promise<string> {
    const raw = await fs.readFile(COOKIES_FILE, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) throw new Error(`${COOKIES_FILE} is empty`);
    return trimmed;
}

/**
 * Persists the current cookie string to disk.
 * Called after each request so rotated DDoS-Guard tokens are never lost.
 */
async function saveCookies(cookies: string): Promise<void> {
    await fs.writeFile(COOKIES_FILE, cookies, 'utf8');
}

// ─── Cookie Merging (pure) ────────────────────────────────────────────────────

/**
 * Merges Set-Cookie headers into the current cookie string.
 * The server rotates __ddg* tokens on every response; failing to apply them
 * before the next request results in 403.
 * Pure function — no side effects.
 */
function mergeCookies(current: string, setCookieHeaders: string[]): string {
    if (!setCookieHeaders || setCookieHeaders.length === 0) return current;

    const cookieMap = new Map<string, string>();
    for (const pair of current.split(';')) {
        const [k, ...v] = pair.trim().split('=');
        if (k) cookieMap.set(k, v.join('='));
    }

    for (const header of setCookieHeaders) {
        const [kv] = header.split(';');
        if (!kv) continue;
        const [k, ...v] = kv.trim().split('=');
        if (k) cookieMap.set(k, v.join('='));
    }

    return Array.from(cookieMap.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
}

// ─── HTTP Fetch ───────────────────────────────────────────────────────────────

/**
 * Fetches a JS-object endpoint and returns parsed data + updated cookies.
 *
 * NOTE: Responses are NOT valid JSON — keys are unquoted JS object literals.
 * We use `new Function('return ...')()` to evaluate the response as a JS expression.
 */
async function fetchJsObject(url: string, cookies: string): Promise<{ data: unknown; cookies: string }> {
    const res = await fetch(url, {
        headers: {
            'Cookie': cookies,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
    });

    // Always apply rotated tokens before checking status.
    const updatedCookies = mergeCookies(cookies, res.headers.getSetCookie());

    if (!res.ok) {
        throw new Error(`HTTP ${res.status} at ${url}`);
    }

    const text = await res.text();
    // eslint-disable-next-line no-new-func
    const data = new Function(`return ${text}`)();

    return { data, cookies: updatedCookies };
}

// ─── Delay ────────────────────────────────────────────────────────────────────

const delay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

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