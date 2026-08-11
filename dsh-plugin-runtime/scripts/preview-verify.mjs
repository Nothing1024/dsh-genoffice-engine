/**
 * UF-002/BR-011/UF-003 real-scenario verification, retry-wrapper: runs the
 * inline verification flow up to N times until the doc frame is captured.
 * (The docs app's cold boot can occasionally exceed the panel's 10s preview
 * timeout — the panel then shows its error+retry branch, which is correct
 * product behavior; this harness re-runs the whole flow like a user would.)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const outDir = 'docs/dsh-sidebar-ecosystem/evidence/UF-002'
mkdirSync(outDir, { recursive: true })
mkdirSync('docs/dsh-sidebar-ecosystem/evidence/UF-003', { recursive: true })

const DOCX = '/tmp/genoffice-preview-test/simple.docx'
const FIXTURE_DIR = 'genoffice-preview-test'

async function fileHash() {
  const r = await fetch(`http://localhost:8787/api/file?path=${encodeURIComponent(DOCX)}`)
  const d = await r.json()
  return d.base64
}

const browser = await chromium.launch({ acceptDownloads: true })

for (let attempt = 1; attempt <= 4; attempt += 1) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const warm = await ctx.newPage()
  await warm.goto('http://localhost:8787/docs/', { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {})
  await warm.waitForTimeout(1500)
  await warm.close()

  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 120)) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 120)}`))

  await page.goto('http://127.0.0.1:3080', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(7000)
  await page.click('[role=tab]:has-text("GenOffice")')
  await page.waitForTimeout(2200)

  async function clickRow(name) {
    await page.evaluate((n) => {
      const span = [...document.querySelectorAll('span')].find((s) => s.textContent === n)
      const row = span ? span.closest('div') : null
      if (row) row.click()
    }, name)
    await page.waitForTimeout(1600)
  }
  async function clickBtn(text) {
    await page.evaluate((t) => {
      const btns = [...document.querySelectorAll('button')]
      const b = btns.find((x) => (x.textContent ?? '').trim().includes(t))
      if (b) b.click()
    }, text)
    await page.waitForTimeout(1400)
  }
  async function findDocsFrame() {
    for (let i = 0; i < 7; i += 1) {
      await page.waitForTimeout(1200)
      for (const f of page.frames()) {
        if (f.url().includes('localhost:8787/docs')) return f
      }
    }
    return null
  }

  await clickBtn('.. 上级')
  await clickBtn('.. 上级')
  await clickRow('tmp')
  await clickRow(FIXTURE_DIR)
  const hashBefore = await fileHash()

  await clickRow('simple.docx')
  let docFrame = await findDocsFrame()
  if (docFrame === null) {
    // 10s preview timeout branch: click 重试 once (UF-002 failure branch).
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const b = btns.find((x) => (x.textContent ?? '').trim() === '重试')
      if (b) b.click()
    }).catch(() => {})
    docFrame = await findDocsFrame()
  }

  const hashAfter = await fileHash()
  await page.screenshot({ path: `${outDir}/preview-docx.png` })

  const dlPromise = page.waitForEvent('download', { timeout: 12_000 }).catch(() => null)
  if (docFrame !== null) {
    // BR-011: editing the preview must never write back. Type into the
    // ProseMirror editor (dirties the doc; the app's auto-save then saves),
    // then Ctrl+S — both must produce a download, never a write-back.
    await docFrame.click('.ProseMirror').catch(() => {})
    await page.keyboard.type('侧边栏预览写回测试')
    await page.keyboard.press('Control+s')
  }
  const download = await dlPromise
  const hashAfterSave = await fileHash()

  let docText = null
  if (docFrame !== null) {
    docText = await docFrame.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => 'frame-read-error')
  }

  const popupPromise = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null)
  await clickBtn('在浏览器中打开')
  const popup = await popupPromise
  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {})
    await popup.screenshot({ path: 'docs/dsh-sidebar-ecosystem/evidence/UF-003/open-new-tab.png' }).catch(() => {})
  }

  const verdict = {
    attempt,
    docFrameFound: docFrame !== null,
    docText,
    hashUnchangedAfterPreview: hashBefore === hashAfter,
    ctrlSDownload: download !== null,
    downloadName: download?.suggestedFilename() ?? null,
    hashUnchangedAfterCtrlS: hashBefore === hashAfterSave,
    newTabOpened: popup !== null,
    newTabUrl: popup ? popup.url().slice(0, 100) : null,
    pageErrors: errors.slice(0, 4),
  }
  console.log('VERDICT ' + JSON.stringify(verdict, null, 2))
  writeFileSync(`${outDir}/hash-before-after.txt`,
    `before: ${hashBefore}\nafter preview: ${hashAfter}\nafter ctrl+s: ${hashAfterSave}\nidentical: ${hashBefore === hashAfter && hashBefore === hashAfterSave}\n`)
  writeFileSync(`${outDir}/console.log`, errors.join('\n') + '\n')

  await ctx.close()
  if (docFrame !== null && download !== null && popup !== null) break
}

await browser.close()
