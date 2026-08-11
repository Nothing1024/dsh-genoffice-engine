#!/usr/bin/env node
/**
 * GenOffice Web — static host + relay server (zero dependencies, Node >= 22).
 *
 * Serves the built web app (apps/<app>/web-dist) and provides the browser-only
 * capabilities the renderer cannot do itself:
 *
 *   GET  /api/health          → { ok, name }
 *   GET  /api/dir?path=       → directory listing { ok, path, parent, entries }
 *                              (defaults to the user's home; same security
 *                              policy as /api/file — loopback-only by default,
 *                              GENOFFICE_WEB_OPEN_PATHS=1 on a network host)
 *   POST /api/search/web      { query, maxResults } → DuckDuckGo results
 *   POST /api/search/image    { query, maxResults } → Bing image results
 *   POST /api/fetch-image     { url }               → { base64, mime }
 *   GET  /api/fetch-file?url= { url }               → remote file bytes (CORS-free)
 *   GET  /api/files?path=     { path }              → file from GENOFFICE_WEB_FILES_ROOT
 *                                                     (only enabled when the env var is set;
 *                                                      paths must stay inside the root)
 *
 * Usage:  npm run web            (build + serve on http://localhost:8787)
 *         node web/server.mjs    (serve only, expects web-dist to exist)
 */
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, dirname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number(process.env.PORT || 8787)
/** when set, enables GET /api/files?path= — server-side file opening (whitelisted root) */
const FILES_ROOT = process.env.GENOFFICE_WEB_FILES_ROOT
  ? resolve(process.env.GENOFFICE_WEB_FILES_ROOT)
  : null
/** GET /api/file?path= (absolute local paths) is allowed by default because the
 *  server binds loopback-only; exposing it on a network interface requires
 *  GENOFFICE_WEB_OPEN_PATHS=1 */
const HOST = process.env.HOST || '127.0.0.1'
const ALLOW_ABS_PATHS =
  process.env.GENOFFICE_WEB_OPEN_PATHS === '1' ||
  HOST === '127.0.0.1' ||
  HOST === 'localhost' ||
  HOST === '::1'
/** remote file proxy size cap */
const MAX_FILE_BYTES = 50 * 1024 * 1024
/** injected local files (token → bytes), TTL-scavenged */
const injectedFiles = new Map()
const INJECT_TTL_MS = 30 * 60 * 1000

setInterval(() => {
  const now = Date.now()
  for (const [token, entry] of injectedFiles) {
    if (now - entry.at > INJECT_TTL_MS) injectedFiles.delete(token)
  }
}, 5 * 60 * 1000).unref()

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
}

/** find the first existing web-dist dir among the apps (shell first = the home screen) */
function findStaticRoots() {
  const candidates = ['shell', 'docs', 'markdown', 'pdf', 'sheets', 'slides']
  const roots = []
  for (const app of candidates) {
    const dir = join(ROOT, 'apps', app, 'web-dist')
    if (existsSync(join(dir, 'index.html'))) roots.push({ app, dir })
  }
  return roots
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  return JSON.parse(raw)
}

// ── search backends ─────────────────────────────────────────────

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

function htmlUnescape(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

async function duckDuckGoSearch(query, maxResults) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const resp = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!resp.ok) throw new Error(`DuckDuckGo HTTP ${resp.status}`)
  const html = await resp.text()
  const results = []
  const itemRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  let m
  while ((m = itemRe.exec(html)) && results.length < maxResults) {
    let href = htmlUnescape(m[1])
    try {
      // DDG redirect wrapper (protocol-relative) → real url
      const u = new URL(href, 'https://duckduckgo.com')
      if (u.hostname.endsWith('duckduckgo.com') && u.searchParams.has('uddg')) {
        href = u.searchParams.get('uddg')
      } else {
        href = u.href
      }
    } catch {
      continue
    }
    if (!/^https?:\/\//.test(href)) continue
    results.push({
      title: htmlUnescape(m[2].replace(/<[^>]+>/g, '')).trim(),
      url: href,
      snippet: htmlUnescape(m[3].replace(/<[^>]+>/g, '')).trim(),
    })
  }
  if (results.length === 0) throw new Error('DuckDuckGo returned no results (may be rate-limited)')
  return results
}

/** Bing web search fallback (DuckDuckGo frequently rate-limits automated queries) */
async function bingWebSearch(query, maxResults) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  })
  if (!resp.ok) throw new Error(`Bing HTTP ${resp.status}`)
  const html = await resp.text()
  const results = []
  const algoRe = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)(?=<li class="b_algo"|<\/ol>)/g
  let m
  while ((m = algoRe.exec(html)) && results.length < maxResults) {
    const href = htmlUnescape(m[1])
    const title = htmlUnescape(m[2].replace(/<[^>]+>/g, '')).trim()
    if (!/^https?:\/\//.test(href) || !title) continue
    const snippetMatch = m[3].match(/<p[^>]*>([\s\S]*?)<\/p>/)
    results.push({
      title,
      url: href,
      snippet: snippetMatch
        ? htmlUnescape(snippetMatch[1].replace(/<[^>]+>/g, '')).trim()
        : '',
    })
  }
  if (results.length === 0) throw new Error('Bing returned no results')
  return results
}

async function bingImageSearch(query, maxResults) {
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2`
  const resp = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } })
  if (!resp.ok) throw new Error(`Bing HTTP ${resp.status}`)
  const html = await resp.text()
  const images = []
  const iuscRe = /<a[^>]*class="iusc"[^>]*m="([^"]+)"[^>]*>/g
  for (const m of html.matchAll(iuscRe)) {
    if (images.length >= maxResults) break
    try {
      const meta = JSON.parse(htmlUnescape(m[1]))
      if (meta.murl) {
        images.push({
          title: htmlUnescape(meta.t ?? ''),
          imageUrl: meta.murl,
          sourceUrl: meta.purl ?? '',
          source: 'bing',
          width: meta.mw ?? undefined,
          height: meta.mh ?? undefined,
        })
      }
    } catch {
      /* skip malformed entries */
    }
  }
  if (images.length === 0) throw new Error('Bing returned no images (may be rate-limited)')
  return images
}

// ── API handlers ────────────────────────────────────────────────

async function handleApi(req, res, pathname, body, url) {
  if (req.method === 'GET' && pathname === '/api/health') {
    return json(res, 200, { ok: true, name: 'genoffice-web-relay', port: PORT })
  }

  // remote file proxy: /docs/?open=https://… opens files from any CORS-free host
  if (req.method === 'GET' && pathname === '/api/fetch-file') {
    const target = url.searchParams.get('url') ?? ''
    if (!/^https?:\/\//.test(target)) {
      return json(res, 400, { ok: false, error: 'invalid url' })
    }
    try {
      const resp = await fetch(target, { headers: { 'User-Agent': UA } })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const buf = Buffer.from(await resp.arrayBuffer())
      if (buf.length > MAX_FILE_BYTES) throw new Error(`file too large (>${MAX_FILE_BYTES / 1024 / 1024}MB)`)
      const contentDisposition = resp.headers.get('content-disposition') ?? ''
      const nameMatch = contentDisposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)
      const cdName = nameMatch ? decodeURIComponent(nameMatch[1]) : ''
      const urlName = decodeURIComponent(target.split('/').pop()?.split('?')[0] ?? '')
      return json(res, 200, {
        ok: true,
        base64: buf.toString('base64'),
        mime: resp.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
        name: cdName || urlName || 'remote-file',
      })
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message })
    }
  }

  // server-side file opening: enabled only with GENOFFICE_WEB_FILES_ROOT whitelist
  if (req.method === 'GET' && pathname === '/api/files') {
    if (!FILES_ROOT) {
      return json(res, 200, {
        ok: false,
        error: 'server file opening disabled (set GENOFFICE_WEB_FILES_ROOT to enable)',
      })
    }
    const rel = String(url.searchParams.get('path') ?? '')
    if (!rel) return json(res, 400, { ok: false, error: 'missing path' })
    const resolved = resolve(FILES_ROOT, rel)
    if (resolved !== FILES_ROOT && !resolved.startsWith(FILES_ROOT + sep)) {
      return json(res, 403, { ok: false, error: 'path escapes GENOFFICE_WEB_FILES_ROOT' })
    }
    try {
      const data = await readFile(resolved)
      if (data.length > MAX_FILE_BYTES) {
        throw new Error(`file too large (>${MAX_FILE_BYTES / 1024 / 1024}MB)`)
      }
      return json(res, 200, {
        ok: true,
        base64: data.toString('base64'),
        mime: 'application/octet-stream',
        name: rel.split('/').pop() ?? 'server-file',
      })
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message })
    }
  }

  // absolute local path read: /docs/?open=path:/Users/me/a.docx — loopback-only
  // by default (see ALLOW_ABS_PATHS); used for quick preview from the CLI / DSH
  if (req.method === 'GET' && pathname === '/api/file') {
    if (!ALLOW_ABS_PATHS) {
      return json(res, 200, {
        ok: false,
        error: 'absolute path reading disabled (set GENOFFICE_WEB_OPEN_PATHS=1 when exposing on a network interface)',
      })
    }
    const raw = String(url.searchParams.get('path') ?? '')
    if (!raw) return json(res, 400, { ok: false, error: 'missing path' })
    try {
      const abs = resolve(raw)
      const data = await readFile(abs)
      if (data.length > MAX_FILE_BYTES) {
        throw new Error(`file too large (>${MAX_FILE_BYTES / 1024 / 1024}MB)`)
      }
      return json(res, 200, {
        ok: true,
        base64: data.toString('base64'),
        mime: 'application/octet-stream',
        name: abs.split('/').pop() ?? 'file',
      })
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message })
    }
  }

  // directory listing for the sidebar file browser: same security policy as
  // /api/file (loopback-only by default, GENOFFICE_WEB_OPEN_PATHS=1 on a
  // network host). path defaults to the user's home directory; symlinks are
  // marked but never followed; unreadable paths return ok:false, not a 500.
  if (req.method === 'GET' && pathname === '/api/dir') {
    if (!ALLOW_ABS_PATHS) {
      return json(res, 200, {
        ok: false,
        error: 'absolute path reading disabled (set GENOFFICE_WEB_OPEN_PATHS=1 when exposing on a network interface)',
      })
    }
    const raw = String(url.searchParams.get('path') ?? '')
    const target = raw ? resolve(raw) : homedir()
    try {
      const dirents = await readdir(target, { withFileTypes: true })
      const entries = dirents.map((d) => {
        const name = d.name
        const hidden = name.startsWith('.')
        const symlink = d.isSymbolicLink()
        // Dirent does not follow links: a symlink to a directory reports as a
        // non-directory here on purpose (mark only, never chase).
        const isDir = d.isDirectory()
        let size = null
        let mtimeMs = null
        if (!isDir && !symlink) {
          try {
            const st = statSync(join(target, name))
            size = st.size
            mtimeMs = st.mtimeMs
          } catch {
            // entry raced away or is unreadable — keep size/mtime null
          }
        }
        return {
          name,
          dir: isDir,
          hidden,
          symlink,
          ...(isDir ? {} : { size, mtimeMs, ext: extname(name).toLowerCase().replace(/^\./, '') }),
        }
      })
      // dirs first, then by name; hidden entries (dot-prefixed) always last
      entries.sort((a, b) => {
        if (a.hidden !== b.hidden) return a.hidden ? 1 : -1
        if (a.dir !== b.dir) return a.dir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      return json(res, 200, { ok: true, path: target, parent: dirname(target), entries })
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message })
    }
  }

  // local file injection (used by `node web/open.mjs <file>`): bytes are held
  // in memory with a TTL, the browser pulls them via GET /api/inject/<token>
  if (req.method === 'POST' && pathname === '/api/inject') {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      chunks.push(chunk)
      size += chunk.length
      if (size > MAX_FILE_BYTES) {
        return json(res, 413, { ok: false, error: 'file too large' })
      }
    }
    const buf = Buffer.concat(chunks)
    const name = String(req.headers['x-file-name'] ?? 'injected-file')
      .replace(/[\\/]/g, '_')
      .slice(0, 200)
    let decodedName = name
    try {
      decodedName = decodeURIComponent(name)
    } catch {
      /* keep raw */
    }
    const token = crypto.randomUUID()
    injectedFiles.set(token, { bytes: buf, name: decodedName, at: Date.now() })
    return json(res, 200, { ok: true, token, name: decodedName })
  }

  // one-shot read of an injected file (token is single-use)
  if (req.method === 'GET' && pathname.startsWith('/api/inject/')) {
    const token = pathname.slice('/api/inject/'.length)
    const entry = injectedFiles.get(token)
    if (!entry) return json(res, 404, { ok: false, error: 'token not found or expired' })
    injectedFiles.delete(token)
    return json(res, 200, { ok: true, base64: entry.bytes.toString('base64'), name: entry.name })
  }

  if (req.method === 'POST' && pathname === '/api/search/web') {
    const { query, maxResults } = body
    if (!query) return json(res, 400, { results: [], method: 'error', error: 'missing query' })
    const n = Math.min(Number(maxResults) || 5, 20)
    try {
      const results = await duckDuckGoSearch(query, n)
      return json(res, 200, { results, method: 'duckduckgo' })
    } catch (ddgErr) {
      try {
        const results = await bingWebSearch(query, n)
        return json(res, 200, { results, method: 'bing' })
      } catch (bingErr) {
        return json(res, 200, {
          results: [],
          method: 'error',
          error: `${ddgErr.message}; bing fallback: ${bingErr.message}`,
        })
      }
    }
  }

  if (req.method === 'POST' && pathname === '/api/search/image') {
    const { query, maxResults } = body
    if (!query) return json(res, 400, { images: [], method: 'error', error: 'missing query' })
    try {
      const images = await bingImageSearch(query, Math.min(Number(maxResults) || 6, 20))
      return json(res, 200, { images, method: 'bing' })
    } catch (e) {
      return json(res, 200, { images: [], method: 'error', error: e.message })
    }
  }

  if (req.method === 'POST' && pathname === '/api/fetch-image') {
    const { url } = body
    if (!url || !/^https?:\/\//.test(url)) return json(res, 400, { error: 'invalid url' })
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': UA } })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const buf = Buffer.from(await resp.arrayBuffer())
      if (buf.length > 20 * 1024 * 1024) throw new Error('image too large (>20MB)')
      const mime = resp.headers.get('content-type')?.split(';')[0] || 'image/jpeg'
      return json(res, 200, { base64: buf.toString('base64'), mime })
    } catch (e) {
      return json(res, 200, { error: e.message })
    }
  }

  return json(res, 404, { error: `unknown api: ${pathname}` })
}

// ── static serving ──────────────────────────────────────────────

async function serveStatic(res, pathname, roots) {
  // map /docs, /markdown, ... to their app roots; bare / → docs
  let app = null
  let rest = pathname
  for (const r of roots) {
    if (pathname === `/${r.app}` || pathname.startsWith(`/${r.app}/`)) {
      app = r
      rest = pathname.slice(r.app.length + 1) || '/'
      break
    }
  }
  if (!app) app = roots[0]
  const safe = normalize(rest).replace(/^(\.\.[/\\])+/, '')
  let filePath = join(app.dir, safe)
  if (!filePath.startsWith(app.dir)) filePath = join(app.dir, 'index.html')
  try {
    let data = await readFile(filePath)
    const ext = extname(filePath).toLowerCase()
    if (ext === '' || ext === '.html') {
      // SPA fallback for extensionless asset paths
      if (!existsSync(filePath)) filePath = join(app.dir, 'index.html')
      data = await readFile(filePath)
      res.writeHead(200, { 'Content-Type': MIME['.html'] })
      return res.end(data)
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    try {
      const data = await readFile(join(app.dir, 'index.html'))
      res.writeHead(200, { 'Content-Type': MIME['.html'] })
      return res.end(data)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('404 Not Found — run `npm run web` to build the app first')
    }
  }
}

// ── main ────────────────────────────────────────────────────────

const roots = findStaticRoots()
if (roots.length === 0) {
  console.error('[genoffice-web] no web-dist builds found — run `npm run web:build -w @genoffice/docs` first')
  process.exit(1)
}

const server = createServer(async (req, res) => {
  // CORS: echo loopback origins only (the DSH web GUI at http://127.0.0.1:3080
  // calls /api/* cross-origin). No `*` wildcard and no echo for foreign
  // origins — same-origin (no Origin header) behavior stays untouched.
  const origin = req.headers.origin
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
  }

  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const pathname = decodeURIComponent(url.pathname)

  if (pathname.startsWith('/api/')) {
    // GET endpoints carry no body; /api/inject carries raw bytes — skip the
    // JSON body read for both so the raw stream reaches the handler intact
    let body = {}
    if (req.method !== 'GET' && pathname !== '/api/inject') {
      try {
        body = await readJson(req)
      } catch {
        body = {}
      }
    }
    return handleApi(req, res, pathname, body, url)
  }

  return serveStatic(res, pathname, roots)
})

// loopback-only by default (localhost tooling; set HOST=0.0.0.0 to expose)
server.listen(PORT, HOST, () => {
  console.log(`[genoffice-web] serving: ${roots.map((r) => r.app).join(', ')}`)
  console.log(`[genoffice-web] http://localhost:${PORT}   (health: /api/health)`)
})
