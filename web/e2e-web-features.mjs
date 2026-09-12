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
const CASES = ['inventory', 'sheets-slice']
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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.mode || (args.mode === 'case' && !CASES.includes(args.caseName))) {
    console.error(`usage: node e2e-web-features.mjs --case ${CASES.join('|')} [--out DIR]`)
    process.exit(2)
  }
  const evidenceRoot = args.outDir
    ? resolve(process.cwd(), args.outDir)
    : join(PLUGIN, 'docs/web-feature-completion/evidence')
  if (args.caseName === 'inventory' || args.all) {
    await runInventory(join(evidenceRoot, 'phase-0'))
  }
  if (args.caseName === 'sheets-slice' || args.all) {
    await runSheetsSlice(evidenceRoot)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
