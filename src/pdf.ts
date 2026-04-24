import * as fs from "fs/promises";
import {
    DEFAULT_DELAY_MS,
    delay,
    fetchArrayBuffer,
    fetchText,
    loadCookies,
    requireValue,
    saveCookies,
} from "./common.ts";

// ─── Config ───────────────────────────────────────────────────────────────────

const PDF_BOOK_ID = requireValue(
    process.argv[2] ?? process.env.PDF_BOOK_ID ?? process.env.pdf_book_id,
    "PDF_BOOK_ID or pdf_book_id",
);
const BASE_URL = requireValue(process.env.BASE_URL, "BASE_URL");

const ORIGIN_URL = new URL(BASE_URL).origin;
const PDF_JS_URL = `${ORIGIN_URL}/pages/get_pdf_js/?file=${encodeURIComponent(PDF_BOOK_ID)}`;
const DELAY_MS = DEFAULT_DELAY_MS;
const OUT_DIR = `pdf_${PDF_BOOK_ID}`;

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

function parsePdfManifest(text: string, bookId: string): PdfManifest {
    const assignment = new RegExp(
        `^\\s*PFURL\\.pdf\\[\\s*${bookId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\]\\s*=\\s*`,
    );
    const objectLiteral = text.replace(assignment, "").replace(/;\s*$/, "");

    // The endpoint returns a JS assignment with unquoted keys, not JSON.
    // eslint-disable-next-line no-new-func
    return new Function(`return ${objectLiteral}`)() as PdfManifest;
}

async function fetchPdfManifest(
    url: string,
    cookies: string,
): Promise<{ data: PdfManifest; cookies: string }> {
    const result = await fetchText(url, cookies);
    const text = result.text;
    const data = parsePdfManifest(text, PDF_BOOK_ID);
    return { data, cookies: result.cookies };
}

async function fetchPdfPage(
    url: string,
    cookies: string,
): Promise<{ data: ArrayBuffer; cookies: string }> {
    return fetchArrayBuffer(url, cookies, {
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    });
}

// ─── Output ───────────────────────────────────────────────────────────────────

function formatAuthor(author: PdfAuthor): string {
    return [author.Last, author.First, author.Middle].filter(Boolean).join(" ");
}

function buildMetadata(bookId: string, manifest: PdfManifest, totalPages: number): string {
    const meta = manifest.Meta ?? {};
    const title = meta.Title ?? `PDF ${bookId}`;
    const authors = meta.Authors?.map(formatAuthor).filter(Boolean) ?? [];
    const group = manifest.pages[0];

    const lines = [
        `# ${title}`,
        "",
        `- Book ID: ${bookId}`,
        `- UUID: ${meta.UUID ?? ""}`,
        `- Version: ${meta.version ?? ""}`,
        `- Authors: ${authors.join(", ")}`,
        `- Pages: ${totalPages}`,
        `- Render type: ${group?.rt ?? ""}`,
        `- Width: ${group?.w ?? ""}`,
        `- Height: ${group?.h ?? ""}`,
        "",
    ];

    return lines.join("\n");
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
        throw new Error("Invalid or empty PDF manifest structure");
    }

    const title = manifest.Meta?.Title ?? `PDF ${PDF_BOOK_ID}`;
    console.log(`Book: "${title}" — ${group.p.length} pages`);

    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(
        `${OUT_DIR}/metadata.md`,
        buildMetadata(PDF_BOOK_ID, manifest, group.p.length),
        "utf8",
    );

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

run().catch((err) => {
    console.error("\nFatal error:", err);
    process.exit(1);
});
