import * as fs from 'fs/promises'

import {
  DEFAULT_DELAY_MS,
  delay,
  fetchArrayBuffer,
  fetchText,
  HttpError,
  loadCookies,
  optionalDelayMs,
  requireValue,
  saveCookies,
} from './common.ts'

// ─── Config ───────────────────────────────────────────────────────────────────

const PDF_BOOK_ID = requireValue(
  process.argv[2] ?? process.env.PDF_BOOK_ID ?? process.env.pdf_book_id,
  'PDF_BOOK_ID or pdf_book_id',
)
const BASE_URL = requireValue(process.env.BASE_URL, 'BASE_URL')

const ORIGIN_URL = new URL(BASE_URL).origin
const PDF_JS_URL = `${ORIGIN_URL}/pages/get_pdf_js/?file=${encodeURIComponent(PDF_BOOK_ID)}`
const DELAY_MS = optionalDelayMs(
  process.env.DOWNLOAD_DELAY_MS,
  DEFAULT_DELAY_MS,
  'DOWNLOAD_DELAY_MS',
)
const PAGE_FORMAT_FALLBACKS = ['jpg', 'gif', 'png', 'webp']

// ─── Types ────────────────────────────────────────────────────────────────────

interface PdfAuthor {
  First?: string
  Last?: string
  Middle?: string
}

interface PdfMeta {
  UUID?: string
  version?: string
  Authors?: PdfAuthor[]
  Title?: string
}

interface PdfPage {
  w: number
  h: number
  ext: string
}

interface PdfPageGroup {
  p: PdfPage[]
  rt: string
  w: number
  h: number
}

interface PdfManifest {
  Meta?: PdfMeta
  pages: PdfPageGroup[]
}

// ─── HTTP Fetch ───────────────────────────────────────────────────────────────

function parsePdfManifest(text: string, bookId: string): PdfManifest {
  const assignment = new RegExp(
    `^\\s*PFURL\\.pdf\\[\\s*${bookId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]\\s*=\\s*`,
  )
  const objectLiteral = text.replace(assignment, '').replace(/;\s*$/, '')

  // The endpoint returns a JS assignment with unquoted keys, not JSON.
  // eslint-disable-next-line no-new-func
  return new Function(`return ${objectLiteral}`)() as PdfManifest
}

async function fetchPdfManifest(
  url: string,
  cookies: string,
): Promise<{ data: PdfManifest; cookies: string }> {
  const result = await fetchText(url, cookies)
  const text = result.text
  const data = parsePdfManifest(text, PDF_BOOK_ID)
  return { data, cookies: result.cookies }
}

async function fetchPdfPage(
  url: string,
  cookies: string,
): Promise<{ data: ArrayBuffer; cookies: string }> {
  return fetchArrayBuffer(url, cookies, {
    Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  })
}

// ─── Output ───────────────────────────────────────────────────────────────────

function formatAuthor(author: PdfAuthor): string {
  return [author.Last, author.First, author.Middle].filter(Boolean).join(' ')
}

function buildMetadata(bookId: string, manifest: PdfManifest, totalPages: number): string {
  const meta = manifest.Meta ?? {}
  const title = meta.Title ?? `PDF ${bookId}`
  const authors = meta.Authors?.map(formatAuthor).filter(Boolean) ?? []
  const group = manifest.pages[0]

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
  ]

  return lines.join('\n')
}

function slugifyPathPart(str: string): string {
  const withoutUnsafePathChars = Array.from(str.normalize('NFKC'))
    .filter((char) => char.charCodeAt(0) >= 32 && !'<>:"/\\|?*'.includes(char))
    .join('')

  const slug = withoutUnsafePathChars
    .replace(/[^\wа-яА-ЯёЁ. -]/g, '')
    .trim()
    .replace(/ +/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80)
    .replace(/^\.+$/, '')

  return slug || 'untitled'
}

function outputDir(bookId: string, title: string): string {
  return `pdf_${bookId}_${slugifyPathPart(title)}`
}

function pageUrl(pageNumber: number, ext: string, renderType: string): string {
  const params = new URLSearchParams({
    file: PDF_BOOK_ID,
    page: String(pageNumber),
    rt: renderType,
    ft: ext,
  })

  return `${ORIGIN_URL}/pages/get_pdf_page/?${params.toString()}`
}

function pageExtensionCandidates(page: PdfPage): string[] {
  return Array.from(new Set([page.ext, ...PAGE_FORMAT_FALLBACKS].filter(Boolean)))
}

async function existingPageFile(
  outDir: string,
  pageNumber: number,
  extensions: string[],
): Promise<string | null> {
  for (const ext of extensions) {
    const filename = `${pageNumber}.${ext}`
    try {
      await fs.access(`${outDir}/${filename}`)
      return filename
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) {
        throw err
      }
    }
  }

  return null
}

function missingPagesLine(pages: number[]): string {
  return pages.length === 0 ? '' : `- Missing pages: ${pages.join(', ')}\n`
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  let cookies = await loadCookies()

  console.log(`Fetching PDF manifest: ${PDF_JS_URL}`)
  const manifestResult = await fetchPdfManifest(PDF_JS_URL, cookies)
  cookies = manifestResult.cookies
  await saveCookies(cookies)

  const manifest = manifestResult.data
  const group = manifest.pages?.[0]
  if (!group || !Array.isArray(group.p) || group.p.length === 0 || !group.rt) {
    throw new Error('Invalid or empty PDF manifest structure')
  }

  const title = manifest.Meta?.Title ?? `PDF ${PDF_BOOK_ID}`
  const outDir = outputDir(PDF_BOOK_ID, title)
  console.log(`Book: "${title}" — ${group.p.length} pages`)
  console.log(`Output: ${outDir}/`)

  await fs.mkdir(outDir, { recursive: true })
  await fs.writeFile(
    `${outDir}/metadata.md`,
    buildMetadata(PDF_BOOK_ID, manifest, group.p.length),
    'utf8',
  )

  const missingPages: number[] = []
  let downloadedPages = 0
  let existingPages = 0

  for (const [i, page] of group.p.entries()) {
    const pageNumber = i
    const extensions = pageExtensionCandidates(page)
    const progress = `[${i + 1}/${group.p.length}] page=${pageNumber}`

    const existingFilename = await existingPageFile(outDir, pageNumber, extensions)
    if (existingFilename) {
      existingPages++
      process.stdout.write(`  ${progress} ${existingFilename} exists\r`)
      continue
    }

    let pageResult: { data: ArrayBuffer; cookies: string } | null = null
    let downloadedExt = ''
    const attemptedExtensions: string[] = []

    for (const ext of extensions) {
      attemptedExtensions.push(ext)
      const url = pageUrl(pageNumber, ext, group.rt)

      try {
        pageResult = await fetchPdfPage(url, cookies)
        downloadedExt = ext
        break
      } catch (err) {
        if (err instanceof HttpError) {
          cookies = err.cookies
          await saveCookies(cookies)

          if (err.status === 404) {
            continue
          }
        }

        throw err
      }
    }

    if (!pageResult) {
      missingPages.push(pageNumber)
      process.stdout.write(`  ${progress} missing (${attemptedExtensions.join(', ')})\r`)
      if (i < group.p.length - 1) await delay(DELAY_MS)
      continue
    }

    cookies = pageResult.cookies

    const filename = `${pageNumber}.${downloadedExt}`
    const filepath = `${outDir}/${filename}`
    await fs.writeFile(filepath, Buffer.from(pageResult.data))
    await saveCookies(cookies)
    downloadedPages++

    const fallbackNote = downloadedExt === page.ext ? '' : ` (fallback from ${page.ext})`
    process.stdout.write(`  ${progress} ${filename}${fallbackNote}\r`)

    if (i < group.p.length - 1) await delay(DELAY_MS)
  }

  if (missingPages.length > 0) {
    await fs.appendFile(`${outDir}/metadata.md`, missingPagesLine(missingPages), 'utf8')
  }

  const savedPages = existingPages + downloadedPages
  const missingSummary =
    missingPages.length === 0 ? '' : `, ${missingPages.length} missing: ${missingPages.join(', ')}`
  console.log(`\nDone. ${savedPages}/${group.p.length} pages → ${outDir}/${missingSummary}`)
}

run().catch((err) => {
  console.error('\nFatal error:', err)
  process.exit(1)
})
