import * as fs from 'fs/promises'

import {
  DEFAULT_DELAY_MS,
  authHeaders,
  delay,
  fetchText,
  HttpError,
  loadCookies,
  mergeCookies,
  optionalDelayMs,
  requireValue,
  saveCookies,
} from './common.ts'

const AUDIO_BOOK_ID = requireValue(
  process.argv[2] ?? process.env.AUDIO_BOOK_ID ?? process.env.audio_book_id,
  'AUDIO_BOOK_ID or audio_book_id',
)
const REQUESTED_FORMAT = process.argv[3] ?? process.env.AUDIO_FORMAT
const API_ORIGIN = requireValue(process.env.API_ORIGIN, 'API_ORIGIN')
const DOWNLOAD_ORIGIN = requireValue(process.env.DOWNLOAD_ORIGIN, 'DOWNLOAD_ORIGIN')
const DELAY_MS = optionalDelayMs(
  process.env.DOWNLOAD_DELAY_MS,
  DEFAULT_DELAY_MS,
  'DOWNLOAD_DELAY_MS',
)
const DEFAULT_FORMAT_PREFERENCE = ['standard', 'zip', 'mp4'] as const
const FORMAT_FILE_TYPES = {
  standard: 'standard_quality_mp3',
  zip: 'zip_with_mp3',
  mp4: 'mobile_version_mp4',
} as const

type AudioFormat = keyof typeof FORMAT_FILE_TYPES

interface AudioFile {
  id: number
  filename: string
  mime: string
  extension: string | null
  is_additional: boolean
  release_date: string | null
  pages: number | null
  size: number | null
  seconds: number | null
  pdf_page_size_width: number | null
  pdf_page_size_height: number | null
}

interface AudioFileGroup {
  file_type: string
  files: AudioFile[]
}

interface FilesGroupedResponse {
  status: number
  error: unknown
  payload?: {
    data?: AudioFileGroup[]
  }
}

interface ArtMetadata {
  title?: string
  authors: string[]
  raw?: unknown
}

function filesGroupedUrl(bookId: string): string {
  return `${API_ORIGIN}/foundation/api/arts/${encodeURIComponent(bookId)}/files/grouped`
}

function artMetadataUrl(bookId: string): string {
  return `${API_ORIGIN}/foundation/api/arts/${encodeURIComponent(bookId)}`
}

function downloadUrl(bookId: string, file: AudioFile): string {
  return `${DOWNLOAD_ORIGIN}/download_book_subscr/${encodeURIComponent(bookId)}/${encodeURIComponent(
    String(file.id),
  )}/${encodeURIComponent(file.filename)}`
}

async function fetchJson<T>(url: string, cookies: string): Promise<{ data: T; cookies: string }> {
  const result = await fetchText(url, cookies, {
    Accept: 'application/json',
  })
  return { data: JSON.parse(result.text) as T, cookies: result.cookies }
}

async function fetchArtMetadata(
  bookId: string,
  cookies: string,
): Promise<{
  metadata: ArtMetadata
  cookies: string
}> {
  try {
    const result = await fetchJson<unknown>(artMetadataUrl(bookId), cookies)
    return { metadata: extractArtMetadata(result.data), cookies: result.cookies }
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 403)) {
      return { metadata: { authors: [] }, cookies: err.cookies }
    }
    if (err instanceof SyntaxError) {
      return { metadata: { authors: [] }, cookies }
    }
    throw err
  }
}

function objectValue(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}

function payloadData(value: unknown): unknown {
  return objectValue(objectValue(value, 'payload'), 'data') ?? objectValue(value, 'data') ?? value
}

function firstString(value: unknown, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = objectValue(value, key)
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return undefined
}

function authorName(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value !== 'object' || value === null) return ''

  const first = firstString(value, ['first_name', 'firstName', 'First'])
  const middle = firstString(value, ['middle_name', 'middleName', 'Middle'])
  const last = firstString(value, ['last_name', 'lastName', 'Last'])
  const full = firstString(value, ['full_name', 'fullName', 'name'])

  return [last, first, middle].filter(Boolean).join(' ') || full || ''
}

function extractAuthors(value: unknown): string[] {
  const authors = objectValue(value, 'authors') ?? objectValue(value, 'Authors')
  if (!Array.isArray(authors)) return []
  return authors.map(authorName).filter(Boolean)
}

function extractArtMetadata(value: unknown): ArtMetadata {
  const data = payloadData(value)
  const title = firstString(data, ['title', 'Title', 'name'])
  return {
    title,
    authors: extractAuthors(data),
    raw: data,
  }
}

function assertFileGroups(response: FilesGroupedResponse): AudioFileGroup[] {
  if (response.status !== 200) {
    throw new Error(`Unexpected files response status: ${response.status}`)
  }

  const groups = response.payload?.data
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error('Invalid or empty audio files structure')
  }

  return groups.filter((group) => Array.isArray(group.files) && group.files.length > 0)
}

function normalizeFormat(format: string): AudioFormat {
  if (format === 'standard' || format === 'zip' || format === 'mp4') return format
  throw new Error(`Unknown audio format "${format}". Use one of: standard, zip, mp4`)
}

function formatForFileType(fileType: string): AudioFormat | undefined {
  return Object.entries(FORMAT_FILE_TYPES).find(([, value]) => value === fileType)?.[0] as
    | AudioFormat
    | undefined
}

function selectFileGroup(groups: AudioFileGroup[], requestedFormat?: string): AudioFileGroup {
  if (requestedFormat) {
    const fileType = FORMAT_FILE_TYPES[normalizeFormat(requestedFormat)]
    const exact = groups.find((group) => group.file_type === fileType)
    if (!exact) {
      const available = groups.map((group) => formatForFileType(group.file_type)).filter(Boolean)
      throw new Error(`Audio format "${requestedFormat}" not found. Available: ${available}`)
    }
    return exact
  }

  for (const format of DEFAULT_FORMAT_PREFERENCE) {
    const group = groups.find((candidate) => candidate.file_type === FORMAT_FILE_TYPES[format])
    if (group) return group
  }

  return groups[0]!
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
  return `audio_${bookId}_${slugifyPathPart(title)}`
}

function safeFilename(filename: string, fallback: string): string {
  const safe = Array.from(filename.normalize('NFKC'))
    .filter((char) => char.charCodeAt(0) >= 32 && !'<>:"/\\|?*'.includes(char))
    .join('')
    .trim()

  return safe && safe !== '.' && safe !== '..' ? safe : fallback
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

function sumNumbers(files: AudioFile[], key: 'size' | 'seconds'): number {
  return files.reduce((sum, file) => sum + (file[key] ?? 0), 0)
}

function buildMetadata(
  bookId: string,
  title: string,
  art: ArtMetadata,
  selectedGroup: AudioFileGroup,
): string {
  const totalSeconds = sumNumbers(selectedGroup.files, 'seconds')
  const selectedFormat = formatForFileType(selectedGroup.file_type) ?? selectedGroup.file_type
  const lines = [
    `# ${title}`,
    '',
    `- Book ID: ${bookId}`,
    `- Authors: ${art.authors.join(', ')}`,
    `- Format: ${selectedFormat}`,
    `- Files: ${selectedGroup.files.length}`,
    `- Duration: ${formatDuration(totalSeconds)} (${totalSeconds} seconds)`,
    '',
  ]

  lines.push('## Files', '')

  for (const file of selectedGroup.files) {
    lines.push(`- ${file.filename} (id=${file.id})`)
  }

  lines.push('')
  return lines.join('\n')
}

async function existingFile(filepath: string): Promise<boolean> {
  try {
    await fs.access(filepath)
    return true
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return false
    throw err
  }
}

function progressLine(label: string, downloaded: number, total: number | null): string {
  if (!total || total <= 0) return `  ${label} ${formatBytes(downloaded)}`

  const percent = ((downloaded / total) * 100).toFixed(1)
  return `  ${label} ${formatBytes(downloaded)} / ${formatBytes(total)} ${percent}%`
}

async function downloadAudioFile(
  url: string,
  filepath: string,
  cookies: string,
  headers: HeadersInit,
  label: string,
  expectedSize: number | null,
): Promise<string> {
  const res = await fetch(url, {
    headers: {
      ...authHeaders(cookies),
      ...headers,
    },
  })

  const updatedCookies = mergeCookies(cookies, res.headers.getSetCookie())

  if (!res.ok) {
    throw new HttpError(res.status, url, updatedCookies)
  }

  if (!res.body) {
    throw new Error(`Response body is empty for ${url}`)
  }

  const contentLength = Number(res.headers.get('content-length') ?? 0)
  const total = contentLength > 0 ? contentLength : expectedSize
  const reader = res.body.getReader()
  const file = await fs.open(filepath, 'w')
  let downloaded = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      downloaded += value.byteLength
      await file.write(value)
      process.stdout.write(`${progressLine(label, downloaded, total)}\r`)
    }
  } finally {
    await file.close()
  }

  process.stdout.write(`${progressLine(label, downloaded, total)}\n`)
  return updatedCookies
}

async function run(): Promise<void> {
  let cookies = await loadCookies()

  const groupedUrl = filesGroupedUrl(AUDIO_BOOK_ID)
  console.log(`Fetching audio files: ${groupedUrl}`)
  const groupedResult = await fetchJson<FilesGroupedResponse>(groupedUrl, cookies)
  cookies = groupedResult.cookies
  await saveCookies(cookies)

  const groups = assertFileGroups(groupedResult.data)
  const selectedGroup = selectFileGroup(groups, REQUESTED_FORMAT)

  const artResult = await fetchArtMetadata(AUDIO_BOOK_ID, cookies)
  cookies = artResult.cookies
  await saveCookies(cookies)

  const title = artResult.metadata.title ?? `Audio ${AUDIO_BOOK_ID}`
  const outDir = outputDir(AUDIO_BOOK_ID, title)
  console.log(`Book: "${title}" — ${selectedGroup.files.length} files (${selectedGroup.file_type})`)
  console.log(`Output: ${outDir}/`)

  await fs.mkdir(outDir, { recursive: true })
  await fs.writeFile(
    `${outDir}/metadata.md`,
    buildMetadata(AUDIO_BOOK_ID, title, artResult.metadata, selectedGroup),
    'utf8',
  )

  let downloadedFiles = 0
  let existingFiles = 0

  for (const [i, file] of selectedGroup.files.entries()) {
    const fallbackFilename = `${String(i + 1).padStart(2, '0')}_${file.id}`
    const filename = safeFilename(file.filename, fallbackFilename)
    const filepath = `${outDir}/${filename}`
    const progress = `[${i + 1}/${selectedGroup.files.length}] ${filename}`

    if (await existingFile(filepath)) {
      existingFiles++
      process.stdout.write(`  ${progress} exists\n`)
      continue
    }

    cookies = await downloadAudioFile(
      downloadUrl(AUDIO_BOOK_ID, file),
      filepath,
      cookies,
      { Accept: file.mime || '*/*' },
      progress,
      file.size,
    )
    await saveCookies(cookies)
    downloadedFiles++

    if (i < selectedGroup.files.length - 1) await delay(DELAY_MS)
  }

  const savedFiles = existingFiles + downloadedFiles
  console.log(`\nDone. ${savedFiles}/${selectedGroup.files.length} files → ${outDir}/`)
}

run().catch((err) => {
  console.error('\nFatal error:', err)
  process.exit(1)
})
