/* E2E smoke test #2: drive the ribbon UI to open a real .docx via a stubbed
 * File System Access picker, verify it renders, then save it back via Ctrl+S
 * and verify the bytes written to the stub handle. */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const url = process.argv[2] ?? 'http://localhost:8787/docs/'
const docxPath = process.argv[3] ?? 'fixtures/generated/simple.docx'
const docxBase64 = readFileSync(docxPath).toString('base64')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const consoleErrors = []
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })

// stub the File System Access API with an in-memory handle
await page.evaluate((base64) => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const file = new File([bytes], 'simple.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
  const handle = {
    name: 'simple.docx',
    savedBytes: null,
    async queryPermission() {
      return 'granted'
    },
    async requestPermission() {
      return 'granted'
    },
    async getFile() {
      return file
    },
    async createWritable() {
      const chunks = []
      return {
        async write(data) {
          chunks.push(data instanceof Uint8Array ? data : new Uint8Array(data))
        },
        async close() {
          const total = chunks.reduce((n, c) => n + c.length, 0)
          const merged = new Uint8Array(total)
          let off = 0
          for (const c of chunks) {
            merged.set(c, off)
            off += c.length
          }
          handle.savedBytes = merged
        },
      }
    },
  }
  window.showOpenFilePicker = async () => [handle]
  window.showSaveFilePicker = async () => handle
  window.__fakeHandle = handle
}, docxBase64)

// open via keyboard shortcut (⌘O / Ctrl+O) — same path as the ribbon button
await page.click('.ProseMirror')
await page.keyboard.press('ControlOrMeta+o')
await page.waitForTimeout(8000) // parse + render

const content = await page.evaluate(() => document.querySelector('.ProseMirror')?.textContent ?? '')
console.log('rendered content:', JSON.stringify(content.slice(0, 300)))

// modify + save via Ctrl+S (ribbon key)
await page.click('.ProseMirror')
await page.keyboard.press('ControlOrMeta+End')
await page.keyboard.type(' —— WEB SAVE TEST')
await page.waitForTimeout(1500)
await page.keyboard.press('ControlOrMeta+s')
await page.waitForTimeout(2500)

const saved = await page.evaluate(() => {
  const h = window.__fakeHandle
  return { len: h.savedBytes ? h.savedBytes.length : null }
})
console.log('saved bytes:', JSON.stringify(saved))

const recent = await page.evaluate(async () => await window.desktop.getRecentFiles())
console.log('recents:', JSON.stringify(recent))

console.log('console errors:', consoleErrors.length ? consoleErrors.slice(0, 8) : 'none')
await browser.close()
