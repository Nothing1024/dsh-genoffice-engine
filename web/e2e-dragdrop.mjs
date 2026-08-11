/* E2E: drag & drop a local file onto the home screen / editors to open it. */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const base = process.argv[2] ?? 'http://localhost:8787'
const mdBytes = '# 拖拽测试\n\n这是通过拖拽打开的文件。'

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`home: ${e.message}`))
page.on('console', (m) => m.type() === 'error' && errors.push(`home-console: ${m.text()}`))
page.on('dialog', async (d) => {
  console.log('dialog:', d.message().slice(0, 100))
  await d.dismiss()
})

await page.goto(`${base}/`, { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForTimeout(2500)

// simulate dropping a .md file onto the home screen
const [mdPage] = await Promise.all([
  ctx.waitForEvent('page', { timeout: 15_000 }),
  page.evaluate(async (text) => {
    const file = new File([text], '拖拽测试.md', { type: 'text/markdown' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const drop = new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: dt,
    })
    window.dispatchEvent(drop)
  }, mdBytes),
])

await mdPage.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {})
await mdPage.waitForTimeout(4000)
const mdContent = await mdPage.evaluate(() => document.querySelector('.ProseMirror')?.textContent ?? '')
console.log('dropped md opened in markdown editor:', JSON.stringify(mdContent.slice(0, 100)))

// drop a .docx onto the docs editor page
const [docsPage] = await Promise.all([
  ctx.waitForEvent('page', { timeout: 15_000 }),
  mdPage.evaluate(async () => {
    const file = new File([new Uint8Array([80, 75, 3, 4, 20, 0, 8, 0])], '拖拽文档.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    const dt = new DataTransfer()
    dt.items.add(file)
    window.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
    )
  }),
])
await docsPage.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {})
await docsPage.waitForTimeout(4000)
const docsOk = await docsPage.evaluate(() => typeof window.desktop === 'object')
console.log('dropped docx opened docs editor:', docsOk)

// both files should now appear on the home recents
const recents = await page.evaluate(async () => {
  const r = await window.aiOffice.recents({ limit: 20 })
  return r.entries.map((e) => e.name)
})
console.log('home recents now:', JSON.stringify(recents))

console.log('errors:', errors.length ? errors.slice(0, 5) : 'none')
await browser.close()
