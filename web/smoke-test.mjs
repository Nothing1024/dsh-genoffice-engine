/* Quick smoke test for the GenOffice Docs web build (run with node, uses playwright). */
import { chromium } from 'playwright'

const url = process.argv[2] ?? 'http://localhost:8787/docs/'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const consoleErrors = []
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))

await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForTimeout(3000)

// 1. bridge installed?
const bridgeInfo = await page.evaluate(() => ({
  web: window.__GENOFFICE_WEB__ === true,
  desktop: typeof window.desktop,
  projectApi: typeof window.projectApi,
  recent: typeof window.desktop.getRecentFiles === 'function',
}))
console.log('bridge:', JSON.stringify(bridgeInfo))

// 2. editor mounted?
const mounted = await page.evaluate(() => {
  const editor = document.querySelector('.ProseMirror')
  return {
    proseMirror: !!editor,
    text: editor?.textContent?.slice(0, 80) ?? null,
    bodyText: document.body.innerText.slice(0, 120),
  }
})
console.log('mounted:', JSON.stringify(mounted))

// 3. click into the editor, then type
await page.click('.ProseMirror')
await page.waitForTimeout(300)
await page.keyboard.type('Hello from the web version! 网页版测试。', { delay: 10 })
await page.waitForTimeout(800)
const typed = await page.evaluate(() => document.querySelector('.ProseMirror')?.textContent ?? '')
console.log('typed:', JSON.stringify(typed))

// 4. bridge round-trips
const roundTrips = await page.evaluate(async () => {
  const lang = await window.desktop.getLanguage()
  const theme = await window.desktop.getTheme()
  const settings = await window.desktop.getAiSettings()
  const recent = await window.desktop.getRecentFiles()
  const tabs = await window.desktop.listDocsTabs()
  const status = await window.desktop.aiGskStatus()
  return { lang, theme, provider: settings.provider, recentCount: recent.length, tabs, gsk: status }
})
console.log('roundtrips:', JSON.stringify(roundTrips))

// 5. web search through relay (same-origin /api)
const search = await page.evaluate(async () => {
  const res = await window.desktop.webSearch('genspark ai office', 2)
  return { method: res.method, n: res.results.length, first: res.results[0]?.title ?? null, error: res.error ?? null }
})
console.log('webSearch:', JSON.stringify(search))

// 6. AI settings round-trip (localStorage)
await page.evaluate(async () => {
  const s = await window.desktop.getAiSettings()
  s.provider = 'deepseek'
  s.providers.deepseek = { apiKey: 'test-key', model: 'deepseek-chat' }
  await window.desktop.setAiSettings(s)
})
const settingsAfter = await page.evaluate(async () => (await window.desktop.getAiSettings()).provider)
console.log('aiSettings persist:', settingsAfter)

// 7. theme switch
await page.evaluate(async () => {
  localStorage.setItem('genoffice-web-theme', 'dark')
})
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
const themeAfter = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
console.log('theme after reload:', themeAfter)

await page.screenshot({ path: '/tmp/genoffice-web-dark.png' })

console.log('console errors:', consoleErrors.length ? consoleErrors.slice(0, 8) : 'none')
await browser.close()
