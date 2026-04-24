import * as fs from 'fs/promises';

// ─── Config ───────────────────────────────────────────────────────────────────

const PDF_BOOK_ID = process.env.PDF_BOOK_ID ?? process.env.pdf_book_id;
const BASE_URL = process.env.BASE_URL;

if (!PDF_BOOK_ID) throw new Error('Environment variable PDF_BOOK_ID or pdf_book_id is not set');
if (!BASE_URL) throw new Error('Environment variable BASE_URL is not set');

const ORIGIN_URL = new URL(BASE_URL).origin;
const PDF_JS_URL = `${ORIGIN_URL}/pages/get_pdf_js/?file=${encodeURIComponent(PDF_BOOK_ID)}`;
const DELAY_MS = 500;
const COOKIES_FILE = 'cookies.txt';
const OUT_DIR = `pdf_${PDF_BOOK_ID}`;

// ─── Cookie I/O ───────────────────────────────────────────────────────────────

async function loadCookies(): Promise<string> {
    const raw = await fs.readFile(COOKIES_FILE, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) throw new Error(`${COOKIES_FILE} is empty`);
    return trimmed;
}

async function saveCookies(cookies: string): Promise<void> {
    await fs.writeFile(COOKIES_FILE, cookies, 'utf8');
}

// ─── Cookie Merging ───────────────────────────────────────────────────────────

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

// ─── Types ────────────────────────────────────────────────────────────────────

interface PdfAuthor {
    First?: string;
    Last?: string;
    Middle?: string;
}

interface PdfMeta {
    UUID?: string;
    version?: string;
    Authors?: PdfAuthor[];
    Title?: string;
}

interface PdfPage {
    w: number;
    h: number;
    ext: string;
}

interface PdfPageGroup {
    p: PdfPage[];
    rt: string;
    w: number;
    h: number;
}

interface PdfManifest {
    Meta?: PdfMeta;
    pages: PdfPageGroup[];
}

// ─── HTTP Fetch ───────────────────────────────────────────────────────────────

function requestHeaders(cookies: string): HeadersInit {
    return {
        'Cookie': cookies,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };
}

function parsePdfManifest(text: string, bookId: string): PdfManifest {
    const assignment = new RegExp(`^\\s*PFURL\\.pdf\\[\\s*${bookId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]\\s*=\\s*`);
    const objectLiteral = text
        .replace(assignment, '')
        .replace(/;\s*$/, '');

    // The endpoint returns a JS assignment with unquoted keys, not JSON.
    // eslint-disable-next-line no-new-func
    return new Function(`return ${objectLiteral}`)() as PdfManifest;
}

async function fetchPdfManifest(url: string, cookies: string): Promise<{ data: PdfManifest; cookies: string }> {
    const res = await fetch(url, {
        headers: requestHeaders(cookies),
    });

    const updatedCookies = mergeCookies(cookies, res.headers.getSetCookie());

    if (!res.ok) {
        throw new Error(`HTTP ${res.status} at ${url}`);
    }

    const text = await res.text();
    const data = parsePdfManifest(text, PDF_BOOK_ID);

    return { data, cookies: updatedCookies };
}

async function fetchPdfPage(url: string, cookies: string): Promise<{ data: ArrayBuffer; cookies: string }> {
    const res = await fetch(url, {
        headers: {
            ...requestHeaders(cookies),
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
    });

    const updatedCookies = mergeCookies(cookies, res.headers.getSetCookie());

    if (!res.ok) {
        throw new Error(`HTTP ${res.status} at ${url}`);
    }

    return { data: await res.arrayBuffer(), cookies: updatedCookies };
}

// ─── Output ───────────────────────────────────────────────────────────────────

const delay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function formatAuthor(author: PdfAuthor): string {
    return [author.Last, author.First, author.Middle]
        .filter(Boolean)
        .join(' ');
}

function buildMetadata(bookId: string, manifest: PdfManifest, totalPages: number): string {
    const meta = manifest.Meta ?? {};
    const title = meta.Title ?? `PDF ${bookId}`;
    const authors = meta.Authors?.map(formatAuthor).filter(Boolean) ?? [];
    const group = manifest.pages[0];

    const lines = [
        `# ${title}`,
        '',
        `- Book ID: ${bookId}`,
        `- UUID: ${meta.UUID ?? ''}`,
        `- Version: ${meta.version ?? ''}`,
        `- Authors: ${authors.join(', ')}`,
        `- Pages: ${totalPages}`,
        `- Render type: ${group?.rt ?? ''}`,
        `- Width: ${group?.w ?? ''}`,
        `- Height: ${group?.h ?? ''}`,
        '',
    ];

    return lines.join('\n');
}

function pageUrl(pageNumber: number, page: PdfPage, renderType: string): string {
    const params = new URLSearchParams({
        file: PDF_BOOK_ID,
        page: String(pageNumber),
        rt: renderType,
        ft: page.ext,
    });

    return `${ORIGIN_URL}/pages/get_pdf_page/?${params.toString()}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
    let cookies = await loadCookies();

    console.log(`Fetching PDF manifest: ${PDF_JS_URL}`);
    const manifestResult = await fetchPdfManifest(PDF_JS_URL, cookies);
    cookies = manifestResult.cookies;
    await saveCookies(cookies);

    const manifest = manifestResult.data;
    const group = manifest.pages?.[0];
    if (!group || !Array.isArray(group.p) || group.p.length === 0 || !group.rt) {
        throw new Error('Invalid or empty PDF manifest structure');
    }

    const title = manifest.Meta?.Title ?? `PDF ${PDF_BOOK_ID}`;
    console.log(`Book: "${title}" — ${group.p.length} pages`);

    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(`${OUT_DIR}/metadata.md`, buildMetadata(PDF_BOOK_ID, manifest, group.p.length), 'utf8');

    for (const [i, page] of group.p.entries()) {
        const pageNumber = i + 1;
        const url = pageUrl(pageNumber, page, group.rt);
        const pageResult = await fetchPdfPage(url, cookies);
        cookies = pageResult.cookies;

        await fs.writeFile(`${OUT_DIR}/${pageNumber}.${page.ext}`, Buffer.from(pageResult.data));
        await saveCookies(cookies);

        process.stdout.write(`  [${pageNumber}/${group.p.length}] ${pageNumber}.${page.ext}\r`);

        if (i < group.p.length - 1) await delay(DELAY_MS);
    }

    console.log(`\nDone. ${group.p.length} pages → ${OUT_DIR}/`);
}

run().catch(err => {
    console.error('\nFatal error:', err);
    process.exit(1);
});
