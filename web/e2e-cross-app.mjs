/* Cross-app E2E: seed files on the home screen, click them via the shell
 * bridge, verify the docs/markdown editors load the content in new tabs. */
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://localhost:8787'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`home: ${e.message}`))
page.on('dialog', async (d) => {
  console.log('dialog:', d.message().slice(0, 100))
  await d.dismiss()
})

await page.goto(`${base}/`, { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForTimeout(2500)

// seed a .md and a .docx record into the shared IndexedDB
await page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('genoffice-web')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  const tx = db.transaction('handles', 'readwrite')
  const enc = new TextEncoder()
  tx.objectStore('handles').put(
    { name: '笔记.md', kind: 'bytes', bytes: enc.encode('# 网页版笔记\n\n这是通过主页打开的 Markdown。').buffer, mtime: Date.now(), accessedAt: Date.now() },
    '/webdoc/seed-md/笔记.md',
  )
  tx.objectStore('handles').put(
    { name: '报告.docx', kind: 'bytes', bytes: new Uint8Array([1, 2, 3, 4, 5]), mtime: Date.now() - 1000, accessedAt: Date.now() - 1000 },
    '/webdoc/seed-docx/报告.docx',
  )
  await new Promise((r) => (tx.oncomplete = r))
})

// 1. open the markdown file through the shell bridge → new tab
const [mdPage] = await Promise.all([
  ctx.waitForEvent('page', { timeout: 15_000 }),
  page.evaluate(() => window.aiOffice.openPath('/webdoc/seed-md/笔记.md')),
])
await mdPage.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {})
await mdPage.waitForTimeout(4000)
const mdContent = await mdPage.evaluate(() => document.querySelector('.ProseMirror')?.textContent ?? '')
console.log('markdown tab content:', JSON.stringify(mdContent.slice(0, 120)))
const mdBridge = await mdPage.evaluate(() => typeof window.markdownApi)
console.log('markdown bridge:', mdBridge)

// 2. docs file (invalid bytes but should still load via bridge path)
const [docsPage] = await Promise.all([
  ctx.waitForEvent('page', { timeout: 15_000 }),
  page.evaluate(() => window.aiOffice.openPath('/webdoc/seed-docx/报告.docx')),
])
await docsPage.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {})
await docsPage.waitForTimeout(4000)
const docsBridge = await docsPage.evaluate(() => typeof window.desktop)
console.log('docs tab bridge:', docsBridge)

console.log('errors:', errors.length ? errors.slice(0, 5) : 'none')
await browser.close()
