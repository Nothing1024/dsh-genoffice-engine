/* E2E smoke test for the web home screen (shell Home). */
import { chromium } from 'playwright'

const url = process.argv[2] ?? 'http://localhost:8787/'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const consoleErrors = []
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
page.on('dialog', async (d) => {
  console.log('dialog:', d.message().slice(0, 80))
  await d.dismiss()
})

await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForTimeout(3000)

// 1. bridge installed
const bridge = await page.evaluate(() => ({
  web: window.__GENOFFICE_WEB__ === true,
  aiOffice: typeof window.aiOffice,
  aiOfficeProject: typeof window.aiOfficeProject,
  aiOfficeTabs: typeof window.aiOfficeTabs,
}))
console.log('bridge:', JSON.stringify(bridge))

// 2. Home rendered?
const home = await page.evaluate(() => ({
  body: document.body.innerText.slice(0, 300),
  logo: !!document.querySelector('img[src*="genoffice-logo"]'),
}))
console.log('home:', JSON.stringify(home))

// 3. bridge round-trips
const rt = await page.evaluate(async () => {
  const [recents, starred, theme, version, tabs, onboarding] = await Promise.all([
    window.aiOffice.recents({ limit: 10 }),
    window.aiOffice.starred({ limit: 10 }),
    window.aiOffice.getTheme(),
    window.aiOffice.getAppVersion(),
    window.aiOfficeTabs.list(),
    window.aiOffice.onboardingSeen(),
  ])
  return {
    recentsTotal: recents.total,
    starredTotal: starred.total,
    theme,
    version,
    tabs: tabs.map((t) => t.kind),
    onboarding,
  }
})
console.log('roundtrips:', JSON.stringify(rt))

// 4. seed a fake recent file into the shared IndexedDB (same as the docs bridge writes)
await page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('genoffice-web')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  const tx = db.transaction('handles', 'readwrite')
  tx.objectStore('handles').put(
    {
      name: '演示文档.docx',
      kind: 'bytes',
      bytes: new Uint8Array([1, 2, 3]),
      mtime: Date.now(),
      accessedAt: Date.now(),
      starred: true,
    },
    '/webdoc/seed-1/演示文档.docx',
  )
  await new Promise((r) => (tx.oncomplete = r))
})

// 5. recents now shows the seeded file
const recents2 = await page.evaluate(async () => {
  const page2 = await window.aiOffice.recents({ limit: 10 })
  const starred2 = await window.aiOffice.starred({ limit: 10 })
  return {
    entries: page2.entries.map((e) => ({ name: e.name, ext: e.ext, starred: e.starred })),
    total: page2.total,
    totalAll: page2.totalAll,
    starredTotal: starred2.total,
  }
})
console.log('recents after seed:', JSON.stringify(recents2))

// 6. screenshot
await page.screenshot({ path: '/tmp/genoffice-web-home.png' })
console.log('console errors:', consoleErrors.length ? consoleErrors.slice(0, 8) : 'none')
await browser.close()
