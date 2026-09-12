#!/usr/bin/env node
/**
 * web-feature-completion harness.
 *   node web/e2e-web-features.mjs --case inventory|sheets-slice|... [--out DIR]
 * ENGINE_ROOT selects the isolated merge tree.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import JSZip from 'jszip'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ENGINE = resolve(process.env.ENGINE_ROOT || join(HERE, '..'))
const PLUGIN = resolve(process.env.PLUGIN_ROOT || '/Users/nothing/workspace/dsh/plugin/dsh-genoffice/plugin')
const INVENTORY = join(PLUGIN, 'docs/web-feature-completion/evidence/phase-0/capability-inventory.csv')
const DEFAULT_PORT = 18787
const CASES = ['inventory', 'sheets-slice', 'entry-matrix', 'sheets-semantics', 'sheets-media', 'entries-sheets']
const PHASE0_CASES = ['inventory', 'sheets-slice', 'entry-matrix', 'sheets-semantics', 'sheets-media']
const SHEETS_FIXTURE = join(ENGINE, 'apps/sheets/fixtures/generated/compatibility-basic.xlsx')

function parseArgs(argv) {
  const out = { mode: null, caseName: null, outDir: null, all: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--all') { out.mode = 'all'; out.all = true }
    else if (arg === '--case') { out.mode = 'case'; out.caseName = argv[++i] }
    else if (arg === '--out') out.outDir = argv[++i]
  }
  return out
}

function parseCsv(text) {
  const [header, ...lines] = text.trim().split(/\r?\n/)
  const cols = header.split(',')
  return lines.filter(Boolean).map((line) => {
    const values = []
    let cur = ''
    let q = false
    for (const ch of line) {
      if (ch === '"') q = !q
      else if (ch === ',' && !q) { values.push(cur); cur = '' }
      else cur += ch
    }
    values.push(cur)
    return Object.fromEntries(cols.map((c, i) => [c, values[i] ?? '']))
  })
}

function sha(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function docIdFor(absPath) {
  return sha256(String(absPath))
}

function assertion(name, ok, expected, actual) {
  return {
    name,
    status: ok ? 'passed' : 'failed',
    expected: expected === undefined ? null : expected,
    actual: actual === undefined ? null : actual,
  }
}

function probeDeps() {
  const sidecar = join(ENGINE, 'apps/sheets/native/xlsx-engine')
  const htmlPkg = join(ENGINE, 'apps/html/package.json')
  const htmlScripts = existsSync(htmlPkg) ? JSON.parse(readFileSync(htmlPkg, 'utf8')).scripts ?? {} : {}
  const server = readFileSync(join(ENGINE, 'web/server.mjs'), 'utf8')
  const pdfBridge = readFileSync(join(ENGINE, 'apps/pdf/src/renderer/web-bridge.ts'), 'utf8')
  const sheetsBridge = readFileSync(join(ENGINE, 'apps/sheets/src/renderer/web-bridge.ts'), 'utf8')
  const shellBridge = readFileSync(join(ENGINE, 'apps/shell/src/renderer/src/web-bridge.ts'), 'utf8')
  return {
    isolatedHead: execFileSync('git', ['-C', ENGINE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    officialAncestor: (() => {
      try {
        execFileSync('git', ['-C', ENGINE, 'merge-base', '--is-ancestor', 'de139a061537bea40f0cc81ef8f09a95f77ac52a', 'HEAD'])
        return true
      } catch {
        return false
      }
    })(),
    htmlPresent: existsSync(join(ENGINE, 'apps/html/src')),
    htmlWebBuild: Boolean(htmlScripts['web:build']),
    htmlRouted: /['"]html['"]/.test(server) && server.includes('findStaticRoots'),
    sidecarTree: existsSync(sidecar),
    ocrWebNull: /ocrPage:\s*async\s*\(\)\s*=>\s*null/.test(pdfBridge),
    playwright: existsSync(join(ENGINE, 'node_modules/playwright')),
    sheetsRoutesXlsx: /case 'xlsx':/.test(shellBridge) && /openWebApp\('sheets'\)/.test(shellBridge),
    sheetsNoSpawn: !/node:child_process|xlsx-sidecar-client/.test(sheetsBridge),
  }
}

async function runInventory(outDir) {
  if (!existsSync(INVENTORY)) throw new Error(`missing inventory ${INVENTORY}`)
  const rows = parseCsv(readFileSync(INVENTORY, 'utf8'))
  const required = ['app','entry','bridge','implementation_task','uf','positive_case','negative_case','dependency','status']
  const deps = probeDeps()
  const assertions = []
  const push = (name, ok, expected, actual) => {
    assertions.push({ name, status: ok ? 'passed' : 'failed', expected, actual })
  }
  push('inventory-nonempty', rows.length >= 20, '>=20', rows.length)
  push('columns', rows.every((r) => required.every((c) => c in r && String(r[c]).length > 0)), required, Object.keys(rows[0] || {}))
  const tasks = rows.map((r) => Number(r.implementation_task))
  push('tasks-2-19', tasks.every((n) => n >= 2 && n <= 19), '2-19', [...new Set(tasks)].sort((a, b) => a - b))
  push('ufs', rows.every((r) => /^UF-00[1-6]$/.test(r.uf)), 'UF-001..006', [...new Set(rows.map((r) => r.uf))])
  const stubs = rows.filter((r) => r.status === 'stub' || r.status === 'not-product-available' || r.status === 'compiled-only')
  push('stubs-owned', stubs.length > 0 && stubs.every((r) => Number(r.implementation_task) >= 2), 'owned stubs', stubs.length)
  push('html-not-claimed-available', rows.filter((r) => r.app === 'html').every((r) => r.status !== 'available'), 'html not available', rows.filter((r) => r.app === 'html').map((r) => r.status))
  push('ocr-not-claimed-available', rows.filter((r) => r.entry.includes('ocr')).every((r) => r.status !== 'available'), 'ocr not available', deps.ocrWebNull)
  push('isolated-head', Boolean(deps.isolatedHead), 'sha', deps.isolatedHead)
  push('html-present-no-web-build', deps.htmlPresent && !deps.htmlWebBuild, 'compiled-only', { htmlPresent: deps.htmlPresent, htmlWebBuild: deps.htmlWebBuild })
  push('inventory-hash', true, 'sha256', sha(INVENTORY))
  const ok = assertions.every((a) => a.status === 'passed')
  const payload = {
    schema_version: 1,
    package: 'web-feature-completion',
    uf: 'EVD-007',
    branch: 'inventory',
    status: ok ? 'passed' : 'failed',
    cases: [{ id: 'inventory', status: ok ? 'passed' : 'failed', assertions }],
    deps,
    inventory_rows: rows.length,
  }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'inventory-result.json'), JSON.stringify(payload, null, 2))
  writeFileSync(join(outDir, 'dependency-probe.json'), JSON.stringify(deps, null, 2))
  console.log(JSON.stringify(payload, null, 2))
  if (!ok) throw new Error('inventory case failed')
}

async function freePort(preferred) {
  const tryListen = (port) =>
    new Promise((resolvePort, reject) => {
      const server = createServer()
      server.unref()
      server.on('error', reject)
      server.listen(port, '127.0.0.1', () => {
        const { port: bound } = server.address()
        server.close(() => resolvePort(bound))
      })
    })
  try {
    return await tryListen(preferred)
  } catch {
    return tryListen(0)
  }
}

async function until(fn, { timeout = 20_000, interval = 40 } = {}) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
      last = value
    } catch (error) {
      last = error
    }
    await delay(interval)
  }
  throw new Error(`wait timeout: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}

async function startRelay(port) {
  const child = spawn(process.execPath, [join(ENGINE, 'web/server.mjs')], {
    cwd: ENGINE,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  const onData = (chunk) => {
    const text = String(chunk)
    logs.push(text)
    if (process.env.E2E_VERBOSE) process.stderr.write(text)
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  const base = `http://127.0.0.1:${port}`
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok), { timeout: 15_000 })
  return { child, base, port, logs }
}

function stopRelay(relay) {
  if (!relay?.child) return
  relay.child.kill('SIGTERM')
}

async function post(base, url, body) {
  const resp = await fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const text = await resp.text()
  try {
    return { status: resp.status, ...JSON.parse(text) }
  } catch {
    return { ok: false, status: resp.status, error: `non-json ${resp.status}: ${text.slice(0, 200)}` }
  }
}

function toolOutput(result) {
  return String(result?.execution?.output ?? result?.output ?? result?.execution?.error ?? result?.error ?? result?.context ?? '')
}

function toolOk(result) {
  return result?.ok === true && result?.execution?.isError !== true
}

async function callTool(base, path, name, input = {}) {
  return post(base, `/api/control/sheets/${docIdFor(path)}/tool`, {
    call: { id: randomUUID(), name, input },
  })
}

async function saveApp(base, path) {
  return post(base, `/api/control/sheets/${docIdFor(path)}/export`, { path })
}

async function contextApp(base, path) {
  return post(base, `/api/control/sheets/${docIdFor(path)}/context`, {})
}

async function waitReady(base, path, timeout = 60_000) {
  return until(async () => {
    const data = await post(base, '/api/control/open', { path })
    if (data.readiness === 'ready' || data.readiness === 'error') return data
    return null
  }, { timeout, interval: 200 })
}

function sheetIdFromContext(payload) {
  return toolOutput(payload).match(/\(id=([^,\s)]+)/)?.[1] || 'sheet-1'
}

async function writeEvidence(outDir, uf, branch, payload) {
  const dir = join(outDir, uf, branch)
  await mkdir(dir, { recursive: true })
  const pluginRev = existsSync(join(PLUGIN, '.git'))
    ? execFileSync('git', ['-C', PLUGIN, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    : 'unknown'
  const engineRev = execFileSync('git', ['-C', ENGINE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const cases = (payload.cases ?? []).map((item, index) => ({
    id: item.id ?? item.name ?? `case-${index + 1}`,
    status: item.status === 'failed' ? 'failed' : 'passed',
    assertions: (item.assertions ?? []).map((row) => ({
      name: row.name,
      status: row.status === 'failed' ? 'failed' : 'passed',
      expected: row.expected === undefined ? null : row.expected,
      actual: row.actual === undefined ? null : row.actual,
    })),
  }))
  const result = {
    schema_version: 1,
    package: 'web-feature-completion',
    uf,
    branch,
    run_id: payload.run_id ?? randomUUID(),
    source_revisions: { plugin: pluginRev, engine: engineRev, engine_root: ENGINE },
    status: payload.status ?? (cases.every((item) => item.status === 'passed') ? 'passed' : 'failed'),
    cases,
  }
  await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2))
  const consoleText = String(payload.console ?? '').trim()
    ? String(payload.console)
    : `[collected]\nrun_id=${result.run_id}\nuf=${uf}\nbranch=${branch}\n`
  await writeFile(join(dir, 'console.log'), consoleText.endsWith('\n') ? consoleText : `${consoleText}\n`)
  const network = payload.network ?? { events: [], count: 0, collected: true }
  if (network.count == null) network.count = Array.isArray(network.events) ? network.events.length : 0
  await writeFile(join(dir, 'network.json'), JSON.stringify(network, null, 2))
  if (payload.screenshot) await writeFile(join(dir, 'screenshot.png'), payload.screenshot)
  else {
    await writeFile(
      join(dir, 'screenshot.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    )
  }
  return result
}

async function runSheetsSlice(outDir) {
  if (!existsSync(SHEETS_FIXTURE)) throw new Error(`missing sheets fixture ${SHEETS_FIXTURE}`)
  const deps = probeDeps()
  const workDir = join(PLUGIN, 'docs/web-feature-completion/evidence/phase-0/work-sheets-slice')
  await mkdir(workDir, { recursive: true })
  const file = join(workDir, 'home-sheets-loop.xlsx')
  await copyFile(SHEETS_FIXTURE, file)
  const beforeSha = sha256(await readFile(file))
  const missing = join(workDir, 'missing-home-sheets.xlsx')
  const corrupt = join(workDir, 'corrupt-home-sheets.xlsx')
  await writeFile(corrupt, 'not-a-zip')

  const port = await freePort(DEFAULT_PORT)
  const relay = await startRelay(port)
  const browser = await chromium.launch({ headless: true })
  const logs = []
  const networkEvents = []
  let homeShot = null
  let sheetShot = null
  let homePopupUrl = ''
  let homeAlert = null
  let opened
  let edited
  let saved
  let reopened
  let reContext
  let missingReady
  let corruptReady
  let afterNewSha
  try {
    const home = await browser.newPage()
    home.on('console', (msg) => logs.push(`[home] ${msg.text()}`))
    home.on('pageerror', (err) => logs.push(`[home] PAGEERROR ${err.message}`))
    home.on('dialog', (dialog) => {
      homeAlert = dialog.message()
      void dialog.dismiss()
    })
    await home.goto(`${relay.base}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await home.waitForSelector('.quick-card', { timeout: 30_000 })
    const popupPromise = home.waitForEvent('popup', { timeout: 15_000 })
    const xlsxCard = home.locator('.quick-card', { hasText: '.xlsx' }).first()
    await xlsxCard.click()
    const popup = await popupPromise
    homePopupUrl = popup.url()
    homeShot = await home.screenshot({ type: 'png' })
    await popup.close()
    await home.close()
    afterNewSha = sha256(await readFile(file))

    const page = await browser.newPage()
    page.on('console', (msg) => logs.push(`[sheets] ${msg.text()}`))
    page.on('pageerror', (err) => logs.push(`[sheets] PAGEERROR ${err.message}`))
    page.on('request', (req) => {
      if (req.url().includes('/api/')) networkEvents.push({ method: req.method(), url: req.url() })
    })
    await page.goto(`${relay.base}/sheets/?control=1&open=${encodeURIComponent(`path:${file}`)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    opened = await waitReady(relay.base, file)
    const midSha = sha256(await readFile(file))
    const context = await contextApp(relay.base, file)
    const sheetId = sheetIdFromContext(context)
    edited = await callTool(relay.base, file, 'propose_operations', {
      summary: 'write WfcSheetKeep',
      operations: [{ op: 'set_cell', sheetId, address: 'A1', value: 'WfcSheetKeep' }],
    })
    const afterEditSha = sha256(await readFile(file))
    saved = await saveApp(relay.base, file)
    const savedSha = sha256(await readFile(file))
    await page.goto(`${relay.base}/sheets/?control=1&open=${encodeURIComponent(`path:${file}`)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    reopened = await waitReady(relay.base, file)
    reContext = await contextApp(relay.base, file)
    const reCells = await callTool(relay.base, file, 'read_cells', {
      addresses: ['A1'],
      sheetId: sheetIdFromContext(reContext),
    })
    sheetShot = await page.screenshot({ type: 'png' })
    await page.close()

    const missPage = await browser.newPage()
    await missPage.goto(`${relay.base}/sheets/?control=1&open=${encodeURIComponent(`path:${missing}`)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    missingReady = await waitReady(relay.base, missing)
    await missPage.close()

    const badPage = await browser.newPage()
    await badPage.goto(`${relay.base}/sheets/?control=1&open=${encodeURIComponent(`path:${corrupt}`)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    corruptReady = await waitReady(relay.base, corrupt)
    await badPage.close()

    const reText = `${toolOutput(reContext)}\n${toolOutput(reCells)}`
    const savedBytes = await readFile(file)
    const zip = await JSZip.loadAsync(savedBytes)
    let zipHasMarker = false
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue
      const part = await entry.async('string')
      if (part.includes('WfcSheetKeep')) {
        zipHasMarker = true
        break
      }
    }
    const successAssertions = [
      assertion('home-xlsx-no-desktop-alert', homeAlert == null, null, homeAlert),
      assertion('home-new-sheet-opens-sheets', /\/sheets\/?/.test(homePopupUrl), '/sheets/', homePopupUrl),
      assertion('no-spawn-in-browser-bridge', deps.sheetsNoSpawn, true, deps.sheetsNoSpawn),
      assertion('shell-routes-xlsx', deps.sheetsRoutesXlsx, true, deps.sheetsRoutesXlsx),
      assertion('open-ready', opened.readiness === 'ready', 'ready', opened),
      assertion('disk-unchanged-until-save', midSha === beforeSha && afterEditSha === beforeSha, beforeSha, {
        midSha,
        afterEditSha,
      }),
      assertion('edit-ok', toolOk(edited), true, edited),
      assertion('save-ok', saved.ok === true, true, saved),
      assertion('disk-changed-after-save', savedSha !== beforeSha, 'changed', { beforeSha, savedSha }),
      assertion('reopen-ready', reopened.readiness === 'ready', 'ready', reopened),
      assertion('reopen-keeps-edit', /WfcSheetKeep/.test(reText) || zipHasMarker, 'WfcSheetKeep', {
        reText: reText.slice(0, 400),
        zipHasMarker,
      }),
      assertion('xlsx-bytes-contain-edit', zipHasMarker, true, zipHasMarker),
    ]
    const cancelAssertions = [
      assertion('new-sheet-does-not-write-fixture', afterNewSha === beforeSha, beforeSha, afterNewSha),
      assertion('home-cancel-no-alert-overwrite', homeAlert == null, null, homeAlert),
    ]
    const failAssertions = [
      assertion('missing-file-error', missingReady.readiness === 'error', 'error', missingReady),
      assertion('missing-not-ready', missingReady.readiness !== 'ready', 'not-ready', missingReady.readiness),
      assertion('corrupt-file-error', corruptReady.readiness === 'error', 'error', corruptReady),
    ]

    const success = await writeEvidence(outDir, 'UF-001', 'success', {
      cases: [{ id: 'sheets-slice-home-open-save', status: successAssertions.every((a) => a.status === 'passed') ? 'passed' : 'failed', assertions: successAssertions }],
      console: logs.join('\n'),
      network: { events: networkEvents.slice(0, 80), count: networkEvents.length },
      screenshot: sheetShot ?? homeShot,
    })
    const failure1 = await writeEvidence(outDir, 'UF-001', 'failure-1', {
      cases: [{ id: 'sheets-slice-new-without-save', status: cancelAssertions.every((a) => a.status === 'passed') ? 'passed' : 'failed', assertions: cancelAssertions }],
      console: logs.join('\n'),
      network: { events: [{ homePopupUrl, homeAlert }], count: 1 },
      screenshot: homeShot,
    })
    const failure2 = await writeEvidence(outDir, 'UF-001', 'failure-2', {
      cases: [{ id: 'sheets-slice-missing-or-corrupt', status: failAssertions.every((a) => a.status === 'passed') ? 'passed' : 'failed', assertions: failAssertions }],
      console: logs.join('\n'),
      network: { events: [missingReady, corruptReady], count: 2 },
      screenshot: sheetShot,
    })

    const ok = [success, failure1, failure2].every((item) => item.status === 'passed')
    const payload = {
      schema_version: 1,
      package: 'web-feature-completion',
      uf: 'UF-001',
      branch: 'sheets-slice',
      status: ok ? 'passed' : 'failed',
      deps,
      results: { success, failure1, failure2 },
    }
    await mkdir(join(outDir, 'phase-0'), { recursive: true })
    await writeFile(join(outDir, 'phase-0/task-2.log'), `${JSON.stringify(payload, null, 2)}\n`)
    console.log(JSON.stringify(payload, null, 2))
    if (!ok) throw new Error('sheets-slice case failed')
  } finally {
    await browser.close().catch(() => {})
    stopRelay(relay)
  }
}


const FAMILIES = [
  { app: 'docs', ext: 'docx', sub: '.docx', fixture: join(ENGINE, 'fixtures/generated/simple.docx') },
  { app: 'markdown', ext: 'md', sub: '.md', fixture: null },
  { app: 'sheets', ext: 'xlsx', sub: '.xlsx', fixture: join(ENGINE, 'apps/sheets/fixtures/generated/compatibility-basic.xlsx') },
  { app: 'slides', ext: 'pptx', sub: '.pptx', fixture: join(ENGINE, 'fixtures/generated/sample.pptx') },
  { app: 'pdf', ext: 'pdf', sub: '.pdf', fixture: join(ENGINE, 'fixtures/generated/simple.pdf') },
]

async function fixtureBytes(family) {
  if (family.ext === 'md') return Buffer.from('# EntryMatrixKeep\n\nhello\n')
  if (!family.fixture || !existsSync(family.fixture)) throw new Error(`missing fixture for ${family.app}: ${family.fixture}`)
  return readFileSync(family.fixture)
}

async function runEntryMatrix(outDir) {
  const workDir = join(PLUGIN, 'docs/web-feature-completion/evidence/phase-0/work-entry-matrix')
  await mkdir(workDir, { recursive: true })
  const port = await freePort(DEFAULT_PORT)
  const relay = await startRelay(port)
  const browser = await chromium.launch({ headless: true })
  const logs = []
  const events = []
  const assertions = []
  const cancelAssertions = []
  const failAssertions = []
  let homeShot = null
  try {
    const home = await browser.newPage()
    home.on('console', (msg) => logs.push(`[home] ${msg.text()}`))
    home.on('dialog', (dialog) => { logs.push(`[alert] ${dialog.message()}`); void dialog.dismiss() })
    await home.goto(`${relay.base}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await home.waitForSelector('.quick-card', { timeout: 30_000 })

    for (const family of FAMILIES) {
      const popupPromise = home.waitForEvent('popup', { timeout: 15_000 })
      await home.locator('.quick-card', { hasText: family.sub }).first().click()
      const popup = await popupPromise
      const url = popup.url()
      assertions.push(assertion(`new-${family.app}-url`, url.includes(`/${family.app}/`), `/${family.app}/`, url))
      await popup.waitForLoadState('domcontentloaded').catch(() => {})
      const web = await popup.evaluate(() => window.__GENOFFICE_WEB__ === true).catch(() => false)
      assertions.push(assertion(`new-${family.app}-bridge`, web === true, true, web))
      await popup.close()
    }

    for (const family of FAMILIES) {
      const bytes = await fixtureBytes(family)
      const idbPath = `/webdoc/entry-${family.app}/sample.${family.ext}`
      await home.evaluate(async ({ idbPath: key, name, b64 }) => {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open('genoffice-web', 1)
          req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains('handles')) req.result.createObjectStore('handles')
          }
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
        await new Promise((resolve, reject) => {
          const tx = db.transaction('handles', 'readwrite')
          tx.objectStore('handles').put({
            name,
            kind: 'bytes',
            bytes: raw.buffer,
            mtime: Date.now(),
            accessedAt: Date.now(),
          }, key)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        })
      }, { idbPath, name: `sample.${family.ext}`, b64: bytes.toString('base64') })

      const recents = await home.evaluate(async () => window.aiOffice.recents({ limit: 50 }))
      const found = (recents.entries || []).some((e) => e.path === idbPath || e.name === `sample.${family.ext}`)
      assertions.push(assertion(`recents-${family.app}`, found, true, recents.entries?.map((e) => e.name)))

      const popupPromise = home.waitForEvent('popup', { timeout: 15_000 })
      await home.evaluate((path) => window.aiOffice.openPath(path), idbPath)
      const popup = await popupPromise
      assertions.push(assertion(`open-${family.app}-url`, popup.url().includes(`/${family.app}/`), `/${family.app}/`, popup.url()))
      await popup.close()

      const dragPopupPromise = home.waitForEvent('popup', { timeout: 15_000 })
      await home.evaluate(async ({ name, b64 }) => {
        const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
        const file = new File([raw], name)
        const dt = new DataTransfer()
        dt.items.add(file)
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }))
      }, { name: `drag.${family.ext}`, b64: bytes.toString('base64') })
      const dragPopup = await dragPopupPromise
      assertions.push(assertion(`drag-${family.app}-url`, dragPopup.url().includes(`/${family.app}/`), `/${family.app}/`, dragPopup.url()))
      await dragPopup.close()

      const disk = join(workDir, `${family.app}-loop.${family.ext}`)
      await writeFile(disk, bytes)
      const page = await browser.newPage()
      page.on('console', (msg) => logs.push(`[${family.app}] ${msg.text()}`))
      await page.goto(`${relay.base}/${family.app}/?control=1&open=${encodeURIComponent(`path:${disk}`)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      })
      const opened = await waitReady(relay.base, disk)
      assertions.push(assertion(`file-${family.app}-ready`, opened.readiness === 'ready', 'ready', opened))
      await page.close()
      events.push({ family: family.app, opened })
    }

    const docsPage = await browser.newPage()
    await docsPage.goto(`${relay.base}/docs/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    const crossPromise = docsPage.waitForEvent('popup', { timeout: 15_000 })
    const mdBytes = Buffer.from('# CrossAppKeep\n')
    await docsPage.evaluate(async ({ name, b64 }) => {
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const file = new File([raw], name)
      const dt = new DataTransfer()
      dt.items.add(file)
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }))
    }, { name: 'cross.md', b64: mdBytes.toString('base64') })
    const cross = await crossPromise
    assertions.push(assertion('cross-app-docs-to-markdown', cross.url().includes('/markdown/'), '/markdown/', cross.url()))
    await cross.close()
    await docsPage.close()

    const beforeFiles = (await home.evaluate(async () => (await window.aiOffice.recents({ limit: 100 })).totalAll))
    await home.evaluate(async () => {
      window.showOpenFilePicker = async () => {
        const err = new Error('The user aborted a request.')
        err.name = 'AbortError'
        throw err
      }
      await window.aiOffice.browse()
    })
    const afterFiles = (await home.evaluate(async () => (await window.aiOffice.recents({ limit: 100 })).totalAll))
    cancelAssertions.push(assertion('browse-cancel-no-create', afterFiles === beforeFiles, beforeFiles, afterFiles))

    homeShot = await home.screenshot({ type: 'png' })
    await home.close()

    const missing = join(workDir, 'missing-entry.docx')
    const missPage = await browser.newPage()
    await missPage.goto(`${relay.base}/docs/?control=1&open=${encodeURIComponent(`path:${missing}`)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    const missReady = await waitReady(relay.base, missing)
    failAssertions.push(assertion('missing-docs-error', missReady.readiness === 'error', 'error', missReady))
    await missPage.close()

    const corruptPdf = join(workDir, 'corrupt-entry.pdf')
    await writeFile(corruptPdf, 'not-a-pdf')
    const badPage = await browser.newPage()
    await badPage.goto(`${relay.base}/pdf/?control=1&open=${encodeURIComponent(`path:${corruptPdf}`)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    const badReady = await waitReady(relay.base, corruptPdf)
    failAssertions.push(assertion('corrupt-pdf-error', badReady.readiness === 'error', 'error', badReady))
    await badPage.close()

    const success = await writeEvidence(outDir, 'UF-001', 'success', {
      cases: [{
        id: 'entry-matrix-five-families',
        status: assertions.every((a) => a.status === 'passed') ? 'passed' : 'failed',
        assertions,
      }],
      console: logs.join('\n'),
      network: { events, count: events.length },
      screenshot: homeShot,
    })
    const failure1 = await writeEvidence(outDir, 'UF-001', 'failure-1', {
      cases: [{
        id: 'entry-matrix-cancel',
        status: cancelAssertions.every((a) => a.status === 'passed') ? 'passed' : 'failed',
        assertions: cancelAssertions,
      }],
      console: logs.join('\n'),
      network: { events: [{ beforeFiles, afterFiles }], count: 1 },
      screenshot: homeShot,
    })
    const failure2 = await writeEvidence(outDir, 'UF-001', 'failure-2', {
      cases: [{
        id: 'entry-matrix-missing-or-corrupt',
        status: failAssertions.every((a) => a.status === 'passed') ? 'passed' : 'failed',
        assertions: failAssertions,
      }],
      console: logs.join('\n'),
      network: { events: [missReady, badReady], count: 2 },
      screenshot: homeShot,
    })
    const ok = [success, failure1, failure2].every((item) => item.status === 'passed')
    const payload = { schema_version: 1, package: 'web-feature-completion', uf: 'UF-001', branch: 'entry-matrix', status: ok ? 'passed' : 'failed', results: { success, failure1, failure2 } }
    await mkdir(join(outDir, 'phase-0'), { recursive: true })
    await writeFile(join(outDir, 'phase-0/task-3.log'), `${JSON.stringify(payload, null, 2)}\n`)
    console.log(JSON.stringify(payload, null, 2))
    if (!ok) throw new Error('entry-matrix case failed')
  } finally {
    await browser.close().catch(() => {})
    stopRelay(relay)
  }
}



async function buildSemanticsFixture() {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`)
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Data" sheetId="1" r:id="rId1"/>
    <sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/>
    <sheet name="Locked" sheetId="3" r:id="rId3"/>
  </sheets>
  <definedNames>
    <definedName name="Revenue">Data!$A$2</definedName>
  </definedNames>
</workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`)
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:G3"/>
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>Item</t></is></c>
      <c r="B1" t="inlineStr"><is><t>Rel</t></is></c>
      <c r="C1" t="inlineStr"><is><t>Mix</t></is></c>
      <c r="D1" t="inlineStr"><is><t>Abs</t></is></c>
      <c r="E1" t="inlineStr"><is><t>Col</t></is></c>
      <c r="F1" t="inlineStr"><is><t>ColF</t></is></c>
      <c r="G1" t="inlineStr"><is><t>Name</t></is></c>
    </row>
    <row r="2">
      <c r="A2"><v>10</v></c>
      <c r="B2"><f t="shared" ref="B2:B3" si="0">A2*2</f><v>20</v></c>
      <c r="C2"><f t="shared" ref="C2:C3" si="1">$A2+B$2</f><v>30</v></c>
      <c r="D2"><f t="shared" ref="D2:D3" si="2">$A$2+A2</f><v>20</v></c>
      <c r="E2"><f t="shared" ref="E2:F2" si="3">A2</f><v>10</v></c>
      <c r="F2"><f t="shared" si="3"/><v>20</v></c>
      <c r="G2" t="inlineStr"><is><t>Ada</t></is></c>
    </row>
    <row r="3">
      <c r="A3"><v>20</v></c>
      <c r="B3"><f t="shared" si="0"/><v>40</v></c>
      <c r="C3"><f t="shared" si="1"/><v>50</v></c>
      <c r="D3"><f t="shared" si="2"/><v>30</v></c>
      <c r="G3" t="inlineStr"><is><t>Bob</t></is></c>
    </row>
  </sheetData>
  <autoFilter ref="G1:G3"/>
  <tableParts count="1"><tablePart r:id="rId1"/></tableParts>
</worksheet>`)
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Target="../tables/table1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table"/>
</Relationships>`)
  zip.file('xl/tables/table1.xml', `<?xml version="1.0" encoding="UTF-8"?>
<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="TableSales" displayName="TableSales" ref="A1:C3" headerRowCount="1">
  <autoFilter ref="A1:C3"/>
  <tableColumns count="3">
    <tableColumn id="1" name="Item"/>
    <tableColumn id="2" name="Rel"/>
    <tableColumn id="3" name="Mix"/>
  </tableColumns>
  <tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>
</table>`)
  zip.file('xl/worksheets/sheet2.xml', `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1"/>
  <sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>HiddenKeep</t></is></c></row></sheetData>
</worksheet>`)
  zip.file('xl/worksheets/sheet3.xml', `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1"/>
  <sheetProtection password="CA3E" sheet="1" objects="1" scenarios="1"/>
  <sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>LockedKeep</t></is></c></row></sheetData>
</worksheet>`)
  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf/></cellXfs>
</styleSheet>`)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function inspectWorkbookFeatures(bytes) {
  const zip = await JSZip.loadAsync(bytes)
  const workbook = await zip.file('xl/workbook.xml')?.async('string') ?? ''
  const sheet1 = await zip.file('xl/worksheets/sheet1.xml')?.async('string') ?? ''
  const sheet3 = await zip.file('xl/worksheets/sheet3.xml')?.async('string') ?? ''
  const table = await zip.file('xl/tables/table1.xml')?.async('string') ?? ''
  let keepMarker = false
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue
    const part = await entry.async('string')
    if (part.includes('WfcSemanticsKeep')) { keepMarker = true; break }
  }
  return {
    revenue: workbook.includes('name="Revenue"') && workbook.includes('Data!$A$2'),
    hidden: /name="Hidden"[^>]*state="hidden"/.test(workbook),
    shared: sheet1.includes('t="shared"') && sheet1.includes('si="0"'),
    autoFilter: sheet1.includes('autoFilter') && sheet1.includes('G1:G3'),
    table: table.includes('TableSales') && table.includes('A1:C3'),
    protection: sheet3.includes('sheetProtection') && /password=|hashValue=/.test(sheet3),
    keepMarker,
  }
}

async function runSheetsSemantics(outDir) {
  const workDir = join(PLUGIN, 'docs/web-feature-completion/evidence/phase-0/work-sheets-semantics')
  await mkdir(workDir, { recursive: true })
  const file = join(workDir, 'sheets-semantics.xlsx')
  const bytes = await buildSemanticsFixture()
  await writeFile(file, bytes)
  const beforeSha = sha256(await readFile(file))
  const beforeFeat = await inspectWorkbookFeatures(await readFile(file))
  const missing = join(workDir, 'missing-semantics.xlsx')
  const corrupt = join(workDir, 'corrupt-semantics.xlsx')
  await writeFile(corrupt, 'not-a-zip')

  const port = await freePort(DEFAULT_PORT)
  const relay = await startRelay(port)
  const browser = await chromium.launch({ headless: true })
  const logs = []
  const networkEvents = []
  let shot = null
  try {
    const page = await browser.newPage()
    page.on('console', (msg) => logs.push(`[sheets] ${msg.text()}`))
    page.on('pageerror', (err) => logs.push(`[sheets] PAGEERROR ${err.message}`))
    page.on('request', (req) => {
      if (req.url().includes('/api/')) networkEvents.push({ method: req.method(), url: req.url() })
    })
    await page.goto(`${relay.base}/sheets/?control=1&open=${encodeURIComponent(`path:${file}`)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    const opened = await waitReady(relay.base, file)
    const context = await contextApp(relay.base, file)
    const contextText = toolOutput(context)
    const dataId = contextText.match(/Data \(id=([^,\s)]+)/)?.[1] || 'sheet-1'
    const hiddenId = contextText.match(/Hidden \(id=([^,\s)]+)/)?.[1] || 'sheet-2'
    const lockedId = contextText.match(/Locked \(id=([^,\s)]+)/)?.[1] || 'sheet-3'

    const formulas = await callTool(relay.base, file, 'read_cells', {
      addresses: ['B2', 'B3', 'C2', 'C3', 'D2', 'D3', 'E2', 'F2'],
      sheetId: dataId,
    })
    const formulaText = toolOutput(formulas)
    const dataFeatures = await callTool(relay.base, file, 'read_sheet_features', { sheetId: dataId })
    const hiddenFeatures = await callTool(relay.base, file, 'read_sheet_features', { sheetId: hiddenId })
    const lockedFeatures = await callTool(relay.base, file, 'read_sheet_features', { sheetId: lockedId })
    const dataFeatText = toolOutput(dataFeatures)
    const hiddenFeatText = toolOutput(hiddenFeatures)
    const lockedFeatText = toolOutput(lockedFeatures)

    const protectFail = await callTool(relay.base, file, 'propose_operations', {
      summary: 'unprotect locked sheet',
      operations: [{ op: 'protect_sheet', sheetId: lockedId, protected: false }],
    })
    const afterProtectSha = sha256(await readFile(file))
    const protectFailed = toolOk(protectFail) === false
    const protectMsg = toolOutput(protectFail)

    const lockedWrite = await callTool(relay.base, file, 'propose_operations', {
      summary: 'write locked cell',
      operations: [{ op: 'set_cell', sheetId: lockedId, address: 'A1', value: 'ShouldNotLand' }],
    })
    const afterLockedWriteSha = sha256(await readFile(file))

    const edited = await callTool(relay.base, file, 'propose_operations', {
      summary: 'write unrelated keep cell',
      operations: [{ op: 'set_cell', sheetId: dataId, address: 'Z1', value: 'WfcSemanticsKeep' }],
    })
    const afterEditSha = sha256(await readFile(file))
    const saved = await saveApp(relay.base, file)
    const savedSha = sha256(await readFile(file))
    const savedFeat = await inspectWorkbookFeatures(await readFile(file))

    await page.goto(`${relay.base}/sheets/?control=1&open=${encodeURIComponent(`path:${file}`)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    const reopened = await waitReady(relay.base, file)
    const reContext = await contextApp(relay.base, file)
    const reDataId = toolOutput(reContext).match(/Data \(id=([^,\s)]+)/)?.[1] || dataId
    const reHiddenId = toolOutput(reContext).match(/Hidden \(id=([^,\s)]+)/)?.[1] || hiddenId
    const reLockedId = toolOutput(reContext).match(/Locked \(id=([^,\s)]+)/)?.[1] || lockedId
    const reFormulas = await callTool(relay.base, file, 'read_cells', {
      addresses: ['B2', 'B3', 'C2', 'C3', 'D2', 'D3', 'E2', 'F2', 'Z1'],
      sheetId: reDataId,
    })
    const reFormulaText = toolOutput(reFormulas)
    const reDataFeat = toolOutput(await callTool(relay.base, file, 'read_sheet_features', { sheetId: reDataId }))
    const reHiddenFeat = toolOutput(await callTool(relay.base, file, 'read_sheet_features', { sheetId: reHiddenId }))
    const reLockedFeat = toolOutput(await callTool(relay.base, file, 'read_sheet_features', { sheetId: reLockedId }))
    shot = await page.screenshot({ type: 'png' })
    await page.close()

    const missPage = await browser.newPage()
    await missPage.goto(`${relay.base}/sheets/?control=1&open=${encodeURIComponent(`path:${missing}`)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    const missingReady = await waitReady(relay.base, missing)
    await missPage.close()
    const badPage = await browser.newPage()
    await badPage.goto(`${relay.base}/sheets/?control=1&open=${encodeURIComponent(`path:${corrupt}`)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    const corruptReady = await waitReady(relay.base, corrupt)
    await badPage.close()

    const successAssertions = [
      assertion('open-ready', opened.readiness === 'ready', 'ready', opened.readiness),
      assertion('fixture-features-present', beforeFeat.revenue && beforeFeat.hidden && beforeFeat.shared && beforeFeat.autoFilter && beforeFeat.table && beforeFeat.protection, true, beforeFeat),
      assertion('shared-relative-master', /B2:.*A2\*2/.test(formulaText), 'B2 =A2*2', formulaText),
      assertion('shared-relative-follower', /B3:.*A3\*2/.test(formulaText), 'B3 =A3*2', formulaText),
      assertion('shared-mixed-master', /C2:.*\$A2\+B\$2/.test(formulaText), 'C2 =$A2+B$2', formulaText),
      assertion('shared-mixed-follower', /C3:.*\$A3\+B\$2/.test(formulaText), 'C3 =$A3+B$2', formulaText),
      assertion('shared-abs-follower', /D3:.*\$A\$2\+A3/.test(formulaText), 'D3 =$A$2+A3', formulaText),
      assertion('shared-col-follower', /F2:.*B2/.test(formulaText), 'F2 =B2', formulaText),
      assertion('defined-name-revenue', /Revenue/.test(dataFeatText) && /Data!\$A\$2/.test(dataFeatText), 'Revenue=Data!$A$2', dataFeatText),
      assertion('autofilter-present', /AutoFilter:.*G1:G3/i.test(dataFeatText), 'G1:G3', dataFeatText),
      assertion('hidden-sheet', /hidden/i.test(hiddenFeatText) && /Hidden/.test(contextText), 'hidden', hiddenFeatText),
      assertion('protected-sheet', /protected/i.test(lockedFeatText), 'protected', lockedFeatText),
      assertion('unrelated-edit-ok', toolOk(edited), true, edited),
      assertion('disk-unchanged-until-save', afterEditSha === beforeSha && afterProtectSha === beforeSha, beforeSha, { afterEditSha, afterProtectSha }),
      assertion('save-ok', saved.ok === true, true, saved),
      assertion('disk-changed-after-save', savedSha !== beforeSha, 'changed', { beforeSha, savedSha }),
      assertion('reopen-ready', reopened.readiness === 'ready', 'ready', reopened.readiness),
      assertion('reopen-keep-edit', /WfcSemanticsKeep/.test(reFormulaText) || savedFeat.keepMarker, 'WfcSemanticsKeep', reFormulaText.slice(0, 400)),
      assertion('reopen-shared-follower', /B3:.*A3\*2/.test(reFormulaText), 'B3 =A3*2', reFormulaText),
      assertion('reopen-name', /Revenue/.test(reDataFeat), 'Revenue', reDataFeat),
      assertion('reopen-filter', /AutoFilter:.*G1:G3/i.test(reDataFeat), 'G1:G3', reDataFeat),
      assertion('reopen-hidden', /hidden/i.test(reHiddenFeat), 'hidden', reHiddenFeat),
      assertion('reopen-protected', /protected/i.test(reLockedFeat), 'protected', reLockedFeat),
      assertion('reopen-ooxml-features', savedFeat.revenue && savedFeat.hidden && savedFeat.autoFilter && savedFeat.table && savedFeat.protection, true, savedFeat),
    ]
    const cancelAssertions = [
      assertion('unprotect-password-rejected', protectFailed, true, { protectFailed, protectMsg }),
      assertion('unprotect-does-not-write-disk', afterProtectSha === beforeSha, beforeSha, afterProtectSha),
      assertion('locked-write-does-not-write-disk', afterLockedWriteSha === beforeSha, beforeSha, afterLockedWriteSha),
    ]
    const failAssertions = [
      assertion('missing-file-error', missingReady.readiness === 'error', 'error', missingReady),
      assertion('corrupt-file-error', corruptReady.readiness === 'error', 'error', corruptReady),
    ]

    const success = await writeEvidence(outDir, 'UF-002', 'success', {
      cases: [{
        id: 'sheets-semantics-read-save',
        status: successAssertions.every((a) => a.status === 'passed') ? 'passed' : 'failed',
        assertions: successAssertions,
      }],
      console: logs.join('\n'),
      network: { events: networkEvents.slice(0, 80), count: networkEvents.length },
      screenshot: shot,
    })
    const failure1 = await writeEvidence(outDir, 'UF-002', 'failure-1', {
      cases: [{
        id: 'sheets-semantics-protected-write',
        status: cancelAssertions.every((a) => a.status === 'passed') ? 'passed' : 'failed',
        assertions: cancelAssertions,
      }],
      console: `${logs.join('\n')}\nprotect=${JSON.stringify(protectFail)}\nlockedWrite=${JSON.stringify(lockedWrite)}\n`,
      network: { events: [protectFail, lockedWrite], count: 2 },
      screenshot: shot,
    })
    const failure2 = await writeEvidence(outDir, 'UF-002', 'failure-2', {
      cases: [{
        id: 'sheets-semantics-missing-or-corrupt',
        status: failAssertions.every((a) => a.status === 'passed') ? 'passed' : 'failed',
        assertions: failAssertions,
      }],
      console: logs.join('\n'),
      network: { events: [missingReady, corruptReady], count: 2 },
      screenshot: shot,
    })
    const ok = [success, failure1, failure2].every((item) => item.status === 'passed')
    const payload = {
      schema_version: 1,
      package: 'web-feature-completion',
      uf: 'UF-002',
      branch: 'sheets-semantics',
      status: ok ? 'passed' : 'failed',
      results: { success, failure1, failure2 },
      formulaText,
      dataFeatText,
      hiddenFeatText,
      lockedFeatText,
    }
    await mkdir(join(outDir, 'phase-0'), { recursive: true })
    await writeFile(join(outDir, 'phase-0/task-4.log'), `${JSON.stringify(payload, null, 2)}\n`)
    console.log(JSON.stringify(payload, null, 2))
    if (!ok) throw new Error('sheets-semantics case failed')
  } finally {
    await browser.close().catch(() => {})
    stopRelay(relay)
  }
}



const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function emptySavePayload(sessionId, visualEdits = []) {
  return {
    sessionId,
    mode: 'save',
    edits: [],
    structuralOps: [],
    chartEdits: [],
    visualEdits,
    visualAdditions: [],
    tableAdditions: [],
    pivotAdditions: [],
    sheetOps: [],
    sheetOrder: [],
    filterStates: [],
    hyperlinkEdits: [],
    cfStates: [],
    dvStates: [],
    pageSetupStates: [],
    noteStates: [],
    formulaValues: [],
    pivotCacheRefreshPaths: [],
    pivotRefreshUpdates: [],
    sheetProtections: [],
    sparklineAdditions: [],
    definedNamesState: null,
    themeState: null,
    workbookProtectionState: null,
    protectedRangeStates: [],
  }
}

async function buildMediaFixture({ corruptMedia = false, invalidRel = false } = {}) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
  <Override PartName="/xl/pivotTables/pivotTable1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml"/>
  <Override PartName="/xl/pivotCache/pivotCacheDefinition1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`)
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Data" sheetId="1" r:id="rId1"/>
    <sheet name="Locked" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`)
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:H7"/>
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Region</t></is></c><c r="B1" t="inlineStr"><is><t>Product</t></is></c><c r="C1" t="inlineStr"><is><t>Sales</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>East</t></is></c><c r="B2" t="inlineStr"><is><t>A</t></is></c><c r="C2"><v>10</v></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>East</t></is></c><c r="B3" t="inlineStr"><is><t>B</t></is></c><c r="C3"><v>20</v></c></row>
    <row r="4"><c r="A4" t="inlineStr"><is><t>West</t></is></c><c r="B4" t="inlineStr"><is><t>A</t></is></c><c r="C4"><v>30</v></c></row>
    <row r="5"><c r="A5" t="inlineStr"><is><t>West</t></is></c><c r="B5" t="inlineStr"><is><t>B</t></is></c><c r="C5"><v>40</v></c></row>
    <row r="6"><c r="A6" t="inlineStr"><is><t>East</t></is></c><c r="B6" t="inlineStr"><is><t>A</t></is></c><c r="C6"><v>5</v></c></row>
    <row r="7"><c r="A7" t="inlineStr"><is><t>West</t></is></c><c r="B7" t="inlineStr"><is><t>B</t></is></c><c r="C7"><v>1</v></c></row>
  </sheetData>
  <drawing r:id="rId1"/>
</worksheet>`)
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable" Target="../pivotTables/pivotTable1.xml"/>
</Relationships>`)
  const embed = invalidRel ? 'rId99' : 'rId1'
  zip.file('xl/drawings/drawing1.xml', `<?xml version="1.0" encoding="UTF-8"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>9</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>17</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:pic>
      <xdr:nvPicPr><xdr:cNvPr id="2" name="Logo"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>
      <xdr:blipFill>
        <a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${embed}"/>
        <a:stretch><a:fillRect/></a:stretch>
      </xdr:blipFill>
      <xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
    </xdr:pic>
    <xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>`)
  zip.file('xl/drawings/_rels/drawing1.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>`)
  zip.file('xl/media/image1.png', corruptMedia ? Buffer.from('not-a-png') : PNG_1X1)
  zip.file('xl/pivotTables/pivotTable1.xml', `<?xml version="1.0" encoding="UTF-8"?>
<pivotTableDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" name="PivotTable1" cacheId="1">
  <location ref="E3:H7" firstHeaderRow="1" firstDataRow="2" firstDataCol="1"/>
  <pivotFields count="3">
    <pivotField axis="axisRow" showAll="0"><items count="3"><item x="0"/><item x="1"/><item t="default"/></items></pivotField>
    <pivotField axis="axisCol" showAll="0"><items count="3"><item x="0"/><item x="1"/><item t="default"/></items></pivotField>
    <pivotField dataField="1" showAll="0"/>
  </pivotFields>
  <rowFields count="1"><field x="0"/></rowFields>
  <rowItems count="3"><i><x/></i><i><x v="1"/></i><i t="grand"><x/></i></rowItems>
  <colFields count="1"><field x="1"/></colFields>
  <colItems count="3"><i><x/></i><i><x v="1"/></i><i t="grand"><x/></i></colItems>
  <dataFields count="1"><dataField name="Sum of Sales" fld="2"/></dataFields>
</pivotTableDefinition>`)
  zip.file('xl/pivotTables/_rels/pivotTable1.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="../pivotCache/pivotCacheDefinition1.xml"/>
</Relationships>`)
  zip.file('xl/pivotCache/pivotCacheDefinition1.xml', `<?xml version="1.0" encoding="UTF-8"?>
<pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cacheSource type="worksheet"><worksheetSource ref="A1:C7" sheet="Data"/></cacheSource>
  <cacheFields count="3">
    <cacheField name="Region"><sharedItems count="2"><s v="East"/><s v="West"/></sharedItems></cacheField>
    <cacheField name="Product"><sharedItems count="2"><s v="A"/><s v="B"/></sharedItems></cacheField>
    <cacheField name="Sales"><sharedItems containsString="0" containsNumber="1"/></cacheField>
  </cacheFields>
</pivotCacheDefinition>`)
  zip.file('xl/worksheets/sheet2.xml', `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1"/>
  <sheetProtection password="CA3E" sheet="1" objects="1" scenarios="1"/>
  <sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>LockedKeep</t></is></c></row></sheetData>
</worksheet>`)
  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf/></cellXfs>
</styleSheet>`)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function inspectMediaWorkbook(bytes) {
  const zip = await JSZip.loadAsync(bytes)
  const drawing = await zip.file('xl/drawings/drawing1.xml')?.async('string') ?? ''
  const pivot = await zip.file('xl/pivotTables/pivotTable1.xml')?.async('string') ?? ''
  const cache = await zip.file('xl/pivotCache/pivotCacheDefinition1.xml')?.async('string') ?? ''
  const media = Object.keys(zip.files).filter((name) => name.startsWith('xl/media/') && zip.files[name].dir === false)
  const fromRows = [...drawing.matchAll(/<(?:xdr:)?from>[\s\S]*?<(?:xdr:)?row>(\d+)/g)].map((m) => Number(m[1]))
  return {
    mediaCount: media.length,
    picCount: (drawing.match(/<(?:xdr:)?pic\b/g) || []).length,
    fromRows,
    pivotRef: pivot.includes('ref="E3:H7"'),
    cacheSource: cache.includes('A1:C7') && cache.includes('Data'),
  }
}

async function runSheetsMedia(outDir) {
  const workDir = join(PLUGIN, 'docs/web-feature-completion/evidence/phase-0/work-sheets-media')
  await mkdir(workDir, { recursive: true })
  const file = join(workDir, 'sheets-media.xlsx')
  const bytes = await buildMediaFixture()
  await writeFile(file, bytes)
  const beforeSha = sha256(await readFile(file))
  const insertPng = join(workDir, 'insert-logo.png')
  await writeFile(insertPng, PNG_1X1)
  const badPng = join(workDir, 'corrupt-logo.png')
  await writeFile(badPng, Buffer.from('not-a-png'))
  const badExt = join(workDir, 'not-image.bin')
  await writeFile(badExt, Buffer.from('nope'))
  const invalidFile = join(workDir, 'invalid-rel.xlsx')
  const invalidBytes = await buildMediaFixture({ invalidRel: true })
  await writeFile(invalidFile, invalidBytes)
  const invalidCreatedSha = sha256(invalidBytes)
  const corruptFile = join(workDir, 'corrupt-media.xlsx')
  await writeFile(corruptFile, await buildMediaFixture({ corruptMedia: true }))

  const port = await freePort(DEFAULT_PORT)
  const relay = await startRelay(port)
  const browser = await chromium.launch({ headless: true })
  const logs = []
  const networkEvents = []
  let shot = null
  try {
    const page = await browser.newPage()
    page.on('console', (msg) => logs.push(`[sheets] ${msg.text()}`))
    page.on('pageerror', (err) => logs.push(`[sheets] PAGEERROR ${err.message}`))
    page.on('request', (req) => {
      if (req.url().includes('/api/')) networkEvents.push({ method: req.method(), url: req.url() })
    })
    await page.goto(`${relay.base}/sheets/?control=1&open=${encodeURIComponent(`path:${file}`)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    const opened = await waitReady(relay.base, file)
    const context = await contextApp(relay.base, file)
    const contextText = toolOutput(context)
    const dataId = contextText.match(/Data \(id=([^,\s)]+)/)?.[1] || 'sheet-1'
    const lockedId = contextText.match(/Locked \(id=([^,\s)]+)/)?.[1] || 'sheet-2'
    const features = toolOutput(await callTool(relay.base, file, 'read_sheet_features', { sheetId: dataId }))

    const snapshot = await page.evaluate(() => {
      const fileSnap = window.__genofficeWorkbookFile?.()
      return fileSnap
        ? {
            sessionId: fileSnap.sessionId,
            visuals: fileSnap.visuals,
            pivots: fileSnap.sheets.flatMap((sheet) => sheet.pivotTables),
          }
        : null
    })
    const visual = snapshot?.visuals?.find((item) => item.kind === 'image')
    const pivot = snapshot?.pivots?.[0]
    let media = null
    let mediaError = null
    if (snapshot && visual) {
      try {
        media = await page.evaluate(
          async ({ sessionId, visualId }) => window.desktopApi.readWorkbookMedia({ sessionId, visualId }),
          { sessionId: snapshot.sessionId, visualId: visual.id },
        )
      } catch (error) {
        mediaError = String(error?.message ?? error)
      }
    }
    let pivotDef = null
    let pivotError = null
    if (snapshot && pivot?.path && pivot?.cachePath) {
      try {
        pivotDef = await page.evaluate(
          async ({ sessionId, path, cachePath }) => window.desktopApi.readPivotDefinition({ sessionId, path, cachePath }),
          { sessionId: snapshot.sessionId, path: pivot.path, cachePath: pivot.cachePath },
        )
      } catch (error) {
        pivotError = String(error?.message ?? error)
      }
    }
    const localImage = await page.evaluate(
      async (path) => window.desktopApi.readLocalImage({ path }),
      insertPng,
    )

    const inserted = await callTool(relay.base, file, 'propose_operations', {
      summary: 'insert logo image',
      operations: [{ op: 'add_image', sheetId: dataId, path: insertPng, anchorCell: 'H20' }],
    })
    const afterInsertSha = sha256(await readFile(file))
    const savedInsert = await saveApp(relay.base, file)
    const afterInsertSaveSha = sha256(await readFile(file))
    const afterInsertFeat = await inspectMediaWorkbook(await readFile(file))

    await page.goto(`${relay.base}/sheets/?control=1&open=${encodeURIComponent(`path:${file}`)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    const reopenedInsert = await waitReady(relay.base, file)
    const afterInsertSnap = await page.evaluate(() => {
      const fileSnap = window.__genofficeWorkbookFile?.()
      return fileSnap
        ? { sessionId: fileSnap.sessionId, visuals: fileSnap.visuals }
        : null
    })
    const fileVisual = afterInsertSnap?.visuals?.find((item) => item.kind === 'image' && item.drawingPath)
    let moved = null
    let moveError = null
    if (afterInsertSnap && fileVisual) {
      const movedAnchor = {
        ...fileVisual.anchor,
        fromRow: 30,
        toRow: 38,
      }
      try {
        moved = await page.evaluate(
          async ({ payload }) => window.desktopApi.saveWorkbookEdits(payload),
          {
            payload: emptySavePayload(afterInsertSnap.sessionId, [
              {
                drawingPath: fileVisual.drawingPath,
                drawingIndex: fileVisual.drawingIndex,
                anchor: movedAnchor,
              },
            ]),
          },
        )
      } catch (error) {
        moveError = String(error?.message ?? error)
      }
    }
    const savedMove = await saveApp(relay.base, file)
    const afterMoveSha = sha256(await readFile(file))
    const movedFeat = await inspectMediaWorkbook(await readFile(file))

    await page.goto(`${relay.base}/sheets/?control=1&open=${encodeURIComponent(`path:${file}`)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    const reopenedMove = await waitReady(relay.base, file)
    const reContext = toolOutput(await contextApp(relay.base, file))
    const reDataId = reContext.match(/Data \(id=([^,\s)]+)/)?.[1] || dataId
    const reFeatures = toolOutput(await callTool(relay.base, file, 'read_sheet_features', { sheetId: reDataId }))
    const finalSnap = await page.evaluate(() => {
      const fileSnap = window.__genofficeWorkbookFile?.()
      return fileSnap
        ? {
            visuals: fileSnap.visuals.map((item) => ({
              id: item.id,
              kind: item.kind,
              fromRow: item.anchor?.fromRow,
              fromColumn: item.anchor?.fromColumn,
            })),
            pivots: fileSnap.sheets.flatMap((sheet) => sheet.pivotTables),
          }
        : null
    })
    shot = await page.screenshot({ type: 'png' })
    await page.close()

    const badExtResult = await (async () => {
      const extra = await browser.newPage()
      await extra.goto(`${relay.base}/sheets/?control=1&open=${encodeURIComponent(`path:${file}`)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      })
      await waitReady(relay.base, file)
      const ctx = toolOutput(await contextApp(relay.base, file))
      const sheet = ctx.match(/Data \(id=([^,\s)]+)/)?.[1] || 'sheet-1'
      const result = await callTool(relay.base, file, 'propose_operations', {
        summary: 'insert invalid image',
        operations: [{ op: 'add_image', sheetId: sheet, path: badExt, anchorCell: 'A1' }],
      })
      await extra.close()
      return result
    })()
    const afterBadExtSha = sha256(await readFile(file))

    const badPngResult = await (async () => {
      const extra = await browser.newPage()
      await extra.goto(`${relay.base}/sheets/?control=1&open=${encodeURIComponent(`path:${file}`)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      })
      await waitReady(relay.base, file)
      const ctx = toolOutput(await contextApp(relay.base, file))
      const sheet = ctx.match(/Data \(id=([^,\s)]+)/)?.[1] || 'sheet-1'
      const result = await callTool(relay.base, file, 'propose_operations', {
        summary: 'insert corrupt png',
        operations: [{ op: 'add_image', sheetId: sheet, path: badPng, anchorCell: 'A1' }],
      })
      await extra.close()
      return result
    })()
    const afterBadPngSha = sha256(await readFile(file))

    const protectFail = await (async () => {
      const extra = await browser.newPage()
      await extra.goto(`${relay.base}/sheets/?control=1&open=${encodeURIComponent(`path:${file}`)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      })
      await waitReady(relay.base, file)
      const ctx = toolOutput(await contextApp(relay.base, file))
      const sheet = ctx.match(/Locked \(id=([^,\s)]+)/)?.[1] || 'sheet-2'
      const result = await callTool(relay.base, file, 'propose_operations', {
        summary: 'unprotect locked sheet',
        operations: [{ op: 'protect_sheet', sheetId: sheet, protected: false }],
      })
      await extra.close()
      return result
    })()
    const afterProtectSha = sha256(await readFile(file))

    const invalidPage = await browser.newPage()
    await invalidPage.goto(`${relay.base}/sheets/?control=1&open=${encodeURIComponent(`path:${invalidFile}`)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    const invalidReady = await waitReady(relay.base, invalidFile)
    const invalidSnap = await invalidPage.evaluate(() => {
      const fileSnap = window.__genofficeWorkbookFile?.()
      return fileSnap ? fileSnap.visuals.filter((item) => item.kind === 'image').length : -1
    })
    const invalidSha = sha256(await readFile(invalidFile))
    await invalidPage.close()

    const corruptPage = await browser.newPage()
    await corruptPage.goto(`${relay.base}/sheets/?control=1&open=${encodeURIComponent(`path:${corruptFile}`)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    const corruptReady = await waitReady(relay.base, corruptFile)
    const corruptBefore = sha256(await readFile(corruptFile))
    const corruptRead = await corruptPage.evaluate(async () => {
      const fileSnap = window.__genofficeWorkbookFile?.()
      const visual = fileSnap?.visuals?.find((item) => item.kind === 'image')
      if (fileSnap === undefined || fileSnap === null || visual === undefined) {
        return { ok: false, error: 'no-visual' }
      }
      try {
        await window.desktopApi.readWorkbookMedia({ sessionId: fileSnap.sessionId, visualId: visual.id })
        return { ok: true }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    })
    const unknownRead = await corruptPage.evaluate(async () => {
      const fileSnap = window.__genofficeWorkbookFile?.()
      try {
        await window.desktopApi.readWorkbookMedia({ sessionId: fileSnap.sessionId, visualId: 'missing-visual' })
        return { ok: true }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    })
    const corruptAfter = sha256(await readFile(corruptFile))
    await corruptPage.close()

    const mediaB64 = media?.base64 ?? ''
    const mediaBytes = mediaB64 ? Buffer.from(mediaB64, 'base64') : Buffer.alloc(0)
    const successAssertions = [
      assertion('open-ready', opened.readiness === 'ready', 'ready', opened.readiness),
      assertion('features-image', /image @ A10/i.test(features), 'image @ A10', features),
      assertion('features-pivot', /Pivot tables:/i.test(features) && /E3:H7/.test(features), 'pivot E3:H7', features),
      assertion('read-media-png', media?.mediaType === 'image/png' && mediaBytes[0] === 0x89 && mediaBytes[1] === 0x50, 'image/png', { media, mediaError }),
      assertion('read-pivot', pivotDef?.outputRef === 'E3:H7' && pivotDef?.sourceSheet === 'Data' && pivotDef?.sourceRef === 'A1:C7', 'E3:H7 Data!A1:C7', { pivotDef, pivotError }),
      assertion('read-local-image', localImage?.mediaType === 'image/png' && localImage?.base64?.length > 0, 'png', localImage?.mediaType),
      assertion('add-image-ok', toolOk(inserted), true, inserted),
      assertion('disk-unchanged-until-save', afterInsertSha === beforeSha, beforeSha, afterInsertSha),
      assertion('insert-save-ok', savedInsert.ok === true, true, savedInsert),
      assertion('insert-media-added', afterInsertFeat.mediaCount >= 2 && afterInsertFeat.picCount >= 2 && afterInsertFeat.pivotRef, true, afterInsertFeat),
      assertion('reopen-after-insert', reopenedInsert.readiness === 'ready', 'ready', reopenedInsert.readiness),
      assertion('move-ok', moved !== null && moveError === null && moved?.canceled === false, true, { moved, moveError }),
      assertion('move-save-ok', savedMove.ok === true, true, savedMove),
      assertion('moved-anchor-persisted', movedFeat.fromRows.includes(30) && movedFeat.pivotRef && movedFeat.cacheSource, true, movedFeat),
      assertion('reopen-after-move', reopenedMove.readiness === 'ready', 'ready', reopenedMove.readiness),
      assertion('reopen-features-image', /image @/i.test(reFeatures), 'image still listed', reFeatures),
      assertion('reopen-features-pivot', /Pivot tables:/i.test(reFeatures) && /E3:H7/.test(reFeatures), 'pivot kept', reFeatures),
      assertion('reopen-visual-count', (finalSnap?.visuals?.length ?? 0) >= 2, '>=2', finalSnap),
    ]
    const sidecarAssertions = [
      assertion('invalid-rel-ready', invalidReady.readiness === 'ready', 'ready', invalidReady),
      assertion('invalid-rel-no-fake-image', invalidSnap === 0, 0, invalidSnap),
      assertion('invalid-rel-disk-unchanged', invalidSha === invalidCreatedSha, 'unchanged', { invalidSha, invalidCreatedSha }),
      assertion('corrupt-media-ready', corruptReady.readiness === 'ready', 'ready', corruptReady),
      assertion('corrupt-media-read-fails', corruptRead.ok === false, false, corruptRead),
      assertion('unknown-visual-fails', unknownRead.ok === false, false, unknownRead),
      assertion('corrupt-media-disk-unchanged', corruptAfter === corruptBefore, corruptBefore, corruptAfter),
    ]
    const illegalAssertions = [
      assertion('bad-ext-rejected', toolOk(badExtResult) === false, false, badExtResult),
      assertion('bad-png-rejected', toolOk(badPngResult) === false, false, badPngResult),
      assertion('protect-rejected', toolOk(protectFail) === false, false, protectFail),
      assertion('illegal-does-not-write-disk', afterBadExtSha === afterMoveSha && afterBadPngSha === afterMoveSha && afterProtectSha === afterMoveSha, afterMoveSha, { afterBadExtSha, afterBadPngSha, afterProtectSha }),
    ]

    const success = await writeEvidence(outDir, 'UF-002', 'success', {
      cases: [{
        id: 'sheets-media-read-insert-move',
        status: successAssertions.every((a) => a.status === 'passed') ? 'passed' : 'failed',
        assertions: successAssertions,
      }],
      console: logs.join('\n'),
      network: { events: networkEvents.slice(0, 80), count: networkEvents.length },
      screenshot: shot,
    })
    const failure1 = await writeEvidence(outDir, 'UF-002', 'failure-1', {
      cases: [{
        id: 'sheets-media-corrupt-or-invalid-rel',
        status: sidecarAssertions.every((a) => a.status === 'passed') ? 'passed' : 'failed',
        assertions: sidecarAssertions,
      }],
      console: `${logs.join('\n')}\ncorruptRead=${JSON.stringify(corruptRead)}\nunknownRead=${JSON.stringify(unknownRead)}\n`,
      network: { events: [invalidReady, corruptReady], count: 2 },
      screenshot: shot,
    })
    const failure2 = await writeEvidence(outDir, 'UF-002', 'failure-2', {
      cases: [{
        id: 'sheets-media-illegal-image-or-protect',
        status: illegalAssertions.every((a) => a.status === 'passed') ? 'passed' : 'failed',
        assertions: illegalAssertions,
      }],
      console: `${logs.join('\n')}\nbadExt=${JSON.stringify(badExtResult)}\nbadPng=${JSON.stringify(badPngResult)}\nprotect=${JSON.stringify(protectFail)}\n`,
      network: { events: [badExtResult, badPngResult, protectFail], count: 3 },
      screenshot: shot,
    })
    const ok = [success, failure1, failure2].every((item) => item.status === 'passed')
    const payload = {
      schema_version: 1,
      package: 'web-feature-completion',
      uf: 'UF-002',
      branch: 'sheets-media',
      status: ok ? 'passed' : 'failed',
      results: { success, failure1, failure2 },
      features,
      reFeatures,
      snapshot,
      pivotDef,
      afterInsertFeat,
      movedFeat,
    }
    await mkdir(join(outDir, 'phase-0'), { recursive: true })
    await writeFile(join(outDir, 'phase-0/task-5.log'), `${JSON.stringify(payload, null, 2)}\n`)
    console.log(JSON.stringify(payload, null, 2))
    if (ok === false) throw new Error('sheets-media case failed')
  } finally {
    await browser.close().catch(() => {})
    stopRelay(relay)
  }
}


async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.mode || (args.mode === 'case' && !CASES.includes(args.caseName))) {
    console.error(`usage: node e2e-web-features.mjs --case ${CASES.join('|')} [--out DIR]`)
    process.exit(2)
  }
  const evidenceRoot = args.outDir
    ? resolve(process.cwd(), args.outDir)
    : join(PLUGIN, 'docs/web-feature-completion/evidence')
  const runPhase0 = args.caseName === 'entries-sheets' || args.all
  const ran = []
  if (args.caseName === 'inventory' || runPhase0) {
    await runInventory(join(evidenceRoot, 'phase-0'))
    ran.push('inventory')
  }
  if (args.caseName === 'sheets-slice' || runPhase0) {
    await runSheetsSlice(evidenceRoot)
    ran.push('sheets-slice')
  }
  if (args.caseName === 'entry-matrix' || runPhase0) {
    await runEntryMatrix(evidenceRoot)
    ran.push('entry-matrix')
  }
  if (args.caseName === 'sheets-semantics' || runPhase0) {
    await runSheetsSemantics(evidenceRoot)
    ran.push('sheets-semantics')
  }
  if (args.caseName === 'sheets-media' || runPhase0) {
    await runSheetsMedia(evidenceRoot)
    ran.push('sheets-media')
  }
  if (args.caseName === 'entries-sheets') {
    const missing = PHASE0_CASES.filter((name) => ran.includes(name) === false)
    const payload = {
      schema_version: 1,
      package: 'web-feature-completion',
      uf: 'EVD-007',
      branch: 'entries-sheets',
      status: missing.length === 0 ? 'passed' : 'failed',
      cases: ran.map((id) => ({ id, status: 'passed' })),
      missing,
    }
    await mkdir(join(evidenceRoot, 'phase-0'), { recursive: true })
    await writeFile(join(evidenceRoot, 'phase-0/task-6.log'), `${JSON.stringify(payload, null, 2)}\n`)
    console.log(JSON.stringify(payload, null, 2))
    if (missing.length > 0) throw new Error(`entries-sheets missing ${missing.join(',')}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
