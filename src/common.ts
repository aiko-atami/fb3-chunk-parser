import * as fs from 'fs/promises'

export const COOKIES_FILE = 'cookies.txt'
export const DEFAULT_DELAY_MS = 300

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly cookies: string,
  ) {
    super(`HTTP ${status} at ${url}`)
    this.name = 'HttpError'
  }
}

export function requireValue(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Environment variable ${name} is not set`)
  return value
}

export async function loadCookies(cookiesFile = COOKIES_FILE): Promise<string> {
  const raw = await fs.readFile(cookiesFile, 'utf8')
  const trimmed = raw.trim()
  if (!trimmed) throw new Error(`${cookiesFile} is empty`)
  return trimmed
}

export async function saveCookies(cookies: string, cookiesFile = COOKIES_FILE): Promise<void> {
  await fs.writeFile(cookiesFile, cookies, 'utf8')
}

export function mergeCookies(current: string, setCookieHeaders: string[]): string {
  if (!setCookieHeaders || setCookieHeaders.length === 0) return current

  const cookieMap = new Map<string, string>()
  for (const pair of current.split(';')) {
    const [k, ...v] = pair.trim().split('=')
    if (k) cookieMap.set(k, v.join('='))
  }

  for (const header of setCookieHeaders) {
    const [kv] = header.split(';')
    if (!kv) continue
    const [k, ...v] = kv.trim().split('=')
    if (k) cookieMap.set(k, v.join('='))
  }

  return Array.from(cookieMap.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

export function authHeaders(cookies: string): HeadersInit {
  return {
    Cookie: cookies,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  }
}

export async function fetchText(
  url: string,
  cookies: string,
  headers: HeadersInit = {},
): Promise<{ text: string; cookies: string }> {
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

  return { text: await res.text(), cookies: updatedCookies }
}

export async function fetchArrayBuffer(
  url: string,
  cookies: string,
  headers: HeadersInit = {},
): Promise<{ data: ArrayBuffer; cookies: string }> {
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

  return { data: await res.arrayBuffer(), cookies: updatedCookies }
}

export async function fetchJsObject<T = unknown>(
  url: string,
  cookies: string,
): Promise<{ data: T; cookies: string }> {
  const result = await fetchText(url, cookies)

  // Responses are JS object literals, not valid JSON.
  // eslint-disable-next-line no-new-func
  const data = new Function(`return ${result.text}`)() as T
  return { data, cookies: result.cookies }
}

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
