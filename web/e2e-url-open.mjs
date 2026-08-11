/* E2E: URL-driven file opening — ?open=, ?file= alias, RESTful /f/<b64url> path,
 * remote https:// target via the relay proxy, and server:<relpath> with a
 * GENOFFICE_WEB_FILES_ROOT whitelist. */
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://localhost:8787'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// seed a local md + docx into IndexedDB (via the home page)
const seedPage = await ctx.newPage()
await seedPage.goto(`${base}/`, { waitUntil: 'networkidle', timeout: 60_000 })
await seedPage.waitForTimeout(2000)
await seedPage.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('genoffice-web')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  const tx = db.transaction('handles', 'readwrite')
  tx.objectStore('handles').put(
    { name: '参数打开.md', kind: 'bytes', bytes: new TextEncoder().encode('# 参数打开的文档').buffer, mtime: Date.now(), accessedAt: Date.now() },
    '/webdoc/seed-url/参数打开.md',
  )
  await new Promise((r) => (tx.oncomplete = r))
})
await seedPage.close()

const cases = [
  { name: '?open= synthetic id (md)', url: `${base}/markdown/?open=${encodeURIComponent('/webdoc/seed-url/参数打开.md')}`, expect: '参数打开的文档' },
  { name: '?file= alias (md)', url: `${base}/markdown/?file=${encodeURIComponent('/webdoc/seed-url/参数打开.md')}`, expect: '参数打开的文档' },
  { name: 'RESTful /f/<b64url> path (md)', url: `${base}/markdown/f/${b64url('/webdoc/seed-url/参数打开.md')}`, expect: '参数打开的文档' },
]

for (const c of cases) {
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(c.url, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {})
  await page.waitForTimeout(4000)
  const content = await page.evaluate(() => document.querySelector('.ProseMirror')?.textContent ?? '')
  const urlAfter = page.url()
  console.log(`${c.name}: content=${JSON.stringify(content.slice(0, 40))} cleanUrl=${urlAfter.includes('open=') || urlAfter.includes('file=') ? 'NO' : 'yes'} errors=${errors.length ? errors.slice(0, 2) : 'none'}`)
  await page.close()
}

// remote https:// target → relay proxy. Start a local mock file server.
import { createServer } from 'node:http'
const mock = createServer((req, res) => {
  if (req.url === '/report.md') {
    res.writeHead(200, { 'Content-Type': 'text/markdown' })
    res.end('# 远程报告\n\n从远程服务器拉取的内容。')
  } else {
    res.writeHead(404)
    res.end('nope')
  }
})
await new Promise((r) => mock.listen(9898, r))

const remotePage = await ctx.newPage()
const remoteErrors = []
remotePage.on('pageerror', (e) => remoteErrors.push(e.message))
await remotePage.goto(`${base}/markdown/?open=${encodeURIComponent('http://127.0.0.1:9898/report.md')}`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {})
await remotePage.waitForTimeout(4000)
const remoteContent = await remotePage.evaluate(() => document.querySelector('.ProseMirror')?.textContent ?? '')
console.log(`remote url target: content=${JSON.stringify(remoteContent.slice(0, 60))} errors=${remoteErrors.length ? remoteErrors.slice(0, 2) : 'none'}`)
await remotePage.close()
mock.close()

// relay API checks
const health = await (await fetch(`${base}/api/fetch-file?url=${encodeURIComponent('http://127.0.0.1:9999/nope')}`)).json()
console.log('fetch-file bad host:', JSON.stringify(health.ok), health.error?.slice(0, 40))
const disabled = await (await fetch(`${base}/api/files?path=etc/passwd`)).json()
console.log('server files disabled by default:', JSON.stringify(disabled.ok), disabled.error?.slice(0, 50))

await browser.close()
