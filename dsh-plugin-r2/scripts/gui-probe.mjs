/**
 * GUI probe for the DSH web sidebar plugin (Playwright).
 *
 * Usage: node scripts/gui-probe.mjs <mode> [outDir]
 *   modes:
 *     smoke   — verify the smoke plugin load chain: console marker, corner
 *               badge, and the iframe embedding probe (ASM-002) against the
 *               genoffice relay.
 *     tabs    — verify the TabsRoot container: four tabs, per-tab content
 *               switching, the settings foot seat, collapse/expand restore
 *               (UF-006), and console cleanliness.
 *
 * Saves: <outDir>/console.log (all console lines), <outDir>/iframe.png (if
 * the iframe probe ran), and prints a JSON verdict line.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const mode = process.argv[2] ?? 'smoke'
const outDir = process.argv[3] ?? 'evidence/phase-0'
const gui = 'http://127.0.0.1:3080'
const relay = 'http://localhost:8787'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const consoleLines = []
const pageErrors = []
page.on('console', (msg) => {
  consoleLines.push(`[${msg.type()}] ${msg.text()}`)
})
page.on('pageerror', (err) => {
  pageErrors.push(`pageerror: ${err.message}`)
})

await page.goto(gui, { waitUntil: 'domcontentloaded', timeout: 60_000 })
// Boot manifest parse + plugin mounting happens after first paint; give the
// shell a beat, then wait for the badge (the smoke plugin's visible marker).
await page.waitForTimeout(4000)
try {
  await page.waitForSelector('#genoffice-smoke', { timeout: 30_000 })
} catch {
  // The badge may be missing when the plugin failed — the verdict below reports it.
}

const badge = await page.$('#genoffice-smoke')
const badgeText = badge ? await badge.textContent() : null

// ── ASM-002: iframe embedding probe ─────────────────────────────
let iframeOk = false
let iframeResp = null
if (mode === 'smoke') {
  const respPromise = page.waitForResponse(
    (r) => r.url().startsWith(relay) && r.request().resourceType() === 'document',
    { timeout: 20_000 },
  ).catch(() => null)
  await page.evaluate((src) => {
    const f = document.createElement('iframe')
    f.id = 'genoffice-smoke-iframe'
    f.src = src
    f.style.cssText = 'position:fixed;left:8px;bottom:8px;width:320px;height:180px;z-index:2147483000;background:#fff'
    document.body.appendChild(f)
  }, `${relay}/docs/`)
  iframeResp = await respPromise
  iframeOk = iframeResp !== null && iframeResp.status() === 200
  await page.waitForTimeout(3000)
  await page.screenshot({ path: `${outDir}/iframe.png` })
}

// ── tabs mode: TabsRoot container checks ────────────────────────
let tabsVerdict = null
if (mode === 'tabs') {
  await page.waitForSelector('[role=tab]', { timeout: 30_000 })
  const tabLabels = await page.$$eval('[role=tab]', (els) => els.map((e) => e.textContent.trim()))
  const perTab = {}
  for (const label of ['工作区', '终端', 'GenOffice', '文件']) {
    const idx = tabLabels.indexOf(label)
    if (idx === -1) { perTab[label] = 'tab missing'; continue }
    await page.click(`[role=tab] >> nth=${idx}`)
    await page.waitForTimeout(800)
    perTab[label] = (await page.evaluate(() => document.body.innerText.slice(0, 600))).slice(0, 120)
  }
  // Settings foot seat: ui-settings trigger row should render somewhere in
  // the sidebar column (look for its 设置 trigger aria/text).
  const settingsSeat = await page.evaluate(() => {
    const sidebar = document.querySelector('[data-sidebar-collapsed]')?.parentElement
    const text = document.body.innerText
    return text.includes('设置') || text.includes('Settings')
  })
  // Collapse/expand restore (UF-006): activate GenOffice, collapse, expand.
  await page.click('[role=tab]:has-text("GenOffice")')
  await page.waitForTimeout(500)
  const collapseBtn = await page.$('button[aria-label="折叠侧边栏"]')
  let railVisible = false
  let restoreOk = false
  if (collapseBtn) {
    await collapseBtn.click()
    await page.waitForTimeout(800)
    railVisible = await page.evaluate(() => document.querySelector('[data-sidebar-collapsed]') !== null)
    if (railVisible) {
      // Click the GenOffice rail icon (aria-label=GenOffice) to expand back.
      const railBtn = await page.$('button[aria-label="GenOffice"]')
      if (railBtn) {
        await railBtn.click()
        await page.waitForTimeout(800)
        restoreOk = await page.evaluate(() => {
          const sel = document.querySelector('[role=tab][aria-selected="true"]')
          return sel?.textContent.trim() === 'GenOffice'
        })
      }
    }
  }
  await page.screenshot({ path: `${outDir}/collapse-restore.png` })
  tabsVerdict = { tabLabels, perTab, settingsSeat, railVisible, restoreOk }
}

// ── report ──────────────────────────────────────────────────────
const verdict = {
  mode,
  ...(mode === 'smoke' ? {
    pluginInManifest: await page.evaluate(() => {
      const g = globalThis.__DSH_BOOT__
      return Array.isArray(g?.entries) && g.entries.some((e) => e.id === 'dsh-genoffice-sidebar')
    }),
    badgePresent: badge !== null,
    badgeText,
    iframeProbe: iframeOk,
    iframeStatus: iframeResp?.status() ?? null,
    consoleMarker: consoleLines.some((l) => l.includes('genoffice-smoke')),
  } : {}),
  ...(tabsVerdict !== null ? { tabs: tabsVerdict } : {}),
  pageErrors,
}
console.log('VERDICT ' + JSON.stringify(verdict, null, 2))

mkdirSync(outDir, { recursive: true })
writeFileSync(`${outDir}/console.log`, consoleLines.join('\n') + '\n')
if (badge) await badge.screenshot({ path: `${outDir}/smoke-badge.png` }).catch(() => {})

await browser.close()
