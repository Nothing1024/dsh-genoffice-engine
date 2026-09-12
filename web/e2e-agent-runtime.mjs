#!/usr/bin/env node
/**
 * web-runtime-efficiency harness.
 *   node web/e2e-agent-runtime.mjs --case baseline|... [--out DIR]
 *   node web/e2e-agent-runtime.mjs --all
 */
import { join } from 'node:path'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import {
  EVIDENCE,
  ENGINE,
  PLUGIN,
  DEFAULT_PORT,
  PROTOCOL,
  chromium,
  createFixtures,
  freePort,
  gitHead,
  measureSample,
  probeGaps,
  saveApp,
  startRelay,
  stopRelay,
  editFamily,
  waitReady,
  toolOk,
} from './runtime-measure.mjs'

const IMPLEMENTED = ['baseline', 'no-duplicate-read']

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

function assert(name, passed, expected, actual) {
  return { name, status: passed ? 'passed' : 'failed', expected, actual }
}

async function runBaseline(outDir) {
  const workDir = join(outDir, 'phase-0/work-baseline')
  const fixtures = await createFixtures(workDir)
  const gaps = probeGaps()
  const port = await freePort(DEFAULT_PORT)
  const tRelay0 = Date.now()
  const relay = await startRelay(port)
  const browser = await chromium.launch({ headless: true })
  const samples = []
  const logs = []
  let shot = null
  try {
    const md = fixtures.find((row) => row.app === 'markdown' && row.size === 'small')
    const sample = await measureSample({
      relay,
      browser,
      app: 'markdown',
      file: md.path,
      kind: 'cold',
      marker: 'WreBaselineKeep',
    })
    samples.push(sample)
    const page = await browser.newPage()
    await page.goto(`${relay.base}/markdown/?control=1&open=${encodeURIComponent(`path:${md.path}`)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    shot = await page.screenshot({ type: 'png' })
    page.on('console', (msg) => logs.push(msg.text()))
    await page.close()

    const health = await fetch(`${relay.base}/api/health`).then((r) => r.json())
    const discovery = await fetch(`${relay.base}/api/discovery`).then(async (r) => ({
      status: r.status,
      body: await r.text().then((t) => t.slice(0, 200)),
    })).catch((err) => ({ status: 0, error: err.message }))

    const assertions = [
      { name: 'chromium-present', status: gaps.chromiumExists ? 'passed' : 'failed', expected: true, actual: gaps.chromium },
      { name: 'relay-started', status: Boolean(relay.base) ? 'passed' : 'failed', expected: true, actual: relay.base },
      { name: 'markdown-ready', status: sample.readiness === 'ready' ? 'passed' : 'failed', expected: 'ready', actual: sample.readiness },
      { name: 'markdown-edit-or-save-recorded', status: sample.ok || sample.readiness === 'ready' ? 'passed' : 'failed', expected: true, actual: { editOk: sample.editOk, saveOk: sample.saveOk } },
      { name: 'file-get-counted', status: typeof sample.file_gets === 'number' ? 'passed' : 'failed', expected: 'number', actual: sample.file_gets },
      { name: 'mtime-full-get-gap-recorded', status: typeof gaps.captureMtimeUsesFullFileGet === 'boolean' ? 'passed' : 'failed', expected: 'boolean', actual: gaps.captureMtimeUsesFullFileGet },
      { name: 'no-web-serve-script', status: gaps.scripts.webServe == null ? 'passed' : 'failed', expected: null, actual: gaps.scripts.webServe },
      { name: 'health-any-live', status: gaps.healthReadyAnyLive && health.ready === true ? 'passed' : 'failed', expected: true, actual: { gap: gaps.healthReadyAnyLive, ready: health.ready } },
      { name: 'no-discovery-route', status: gaps.hasDiscoveryRoute === false && discovery.status >= 400 ? 'passed' : 'failed', expected: false, actual: { hasRoute: gaps.hasDiscoveryRoute, http: discovery } },
      { name: 'no-sdk-or-cli-yet', status: gaps.hasSdk === false && gaps.hasCli === false ? 'passed' : 'failed', expected: false, actual: { sdk: gaps.hasSdk, cli: gaps.hasCli } },
      { name: 'html-present', status: gaps.htmlPresent ? 'passed' : 'failed', expected: true, actual: gaps.htmlPresent },
    ]
    const ok = assertions.every((row) => row.status === 'passed')
    const payload = {
      schema_version: 1,
      package: 'web-runtime-efficiency',
      uf: 'UF-001',
      branch: 'baseline',
      status: ok ? 'passed' : 'failed',
      run_id: `wre-baseline-${new Date().toISOString()}`,
      source_revisions: { plugin: gitHead(PLUGIN), engine: gitHead(ENGINE), engine_root: ENGINE },
      protocol: PROTOCOL,
      gaps,
      health,
      discovery,
      fixtures,
      samples,
      relayStartMs: Date.now() - tRelay0,
      cases: [{ id: 'baseline-capabilities-and-gaps', status: ok ? 'passed' : 'failed', assertions }],
    }
    await mkdir(join(outDir, 'phase-0'), { recursive: true })
    await writeFile(join(outDir, 'phase-0/task-1-baseline.json'), `${JSON.stringify(payload, null, 2)}\n`)
    await writeFile(join(outDir, 'phase-0/task-1.log'), `${JSON.stringify(payload, null, 2)}\n`)
    if (shot) await writeFile(join(outDir, 'phase-0/task-1-screenshot.png'), shot)
    console.log(JSON.stringify(payload, null, 2))
    if (!ok) throw new Error('baseline case failed')
    return payload
  } finally {
    await browser.close().catch(() => {})
    stopRelay(relay)
  }
}

async function collectFileGets(page, bucket) {
  page.on('response', async (res) => {
    try {
      if (!res.url().includes('/api/file') || res.request().method() !== 'GET') return
      const body = await res.body()
      let parsed = null
      try { parsed = JSON.parse(body.toString('utf8')) } catch { parsed = null }
      const base64 = typeof parsed?.base64 === 'string' ? parsed.base64 : ''
      bucket.push({
        bytes: body.length,
        url: res.url(),
        hasBase64: base64.length > 0,
        base64Chars: base64.length,
      })
    } catch {
      /* ignore */
    }
  })
}

async function runNoDuplicateRead(outDir) {
  const workDir = join(outDir, 'phase-0/work-no-duplicate-read')
  const fixtures = await createFixtures(workDir)
  const gaps = probeGaps()
  const md = fixtures.find((row) => row.app === 'markdown' && row.size === 'small')
  const port = await freePort(DEFAULT_PORT)
  const relay = await startRelay(port)
  const browser = await chromium.launch({ headless: true })
  const logs = []
  const fileGets = []
  const requests = []
  let shot = null
  try {
    const page = await browser.newPage()
    page.on('console', (msg) => logs.push(`[p1] ${msg.type()}: ${msg.text()}`))
    page.on('request', (req) => {
      if (req.url().includes('/api/')) {
        requests.push({ method: req.method(), url: req.url(), when: 'open-edit-save' })
      }
    })
    await collectFileGets(page, fileGets)
    await page.goto(`${relay.base}/markdown/?control=1&open=${encodeURIComponent(`path:${md.path}`)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    const opened = await waitReady(relay.base, md.path)
    const edited = opened.readiness === 'ready'
      ? await editFamily(relay.base, 'markdown', md.path, 'WreNoDupKeep')
      : { ok: false, skipped: true }
    const saved = opened.readiness === 'ready' ? await saveApp(relay.base, 'markdown', md.path) : { ok: false, skipped: true }
    const fullGetsAfterSave = fileGets.filter((row) => row.hasBase64)
    const extraFullGets = Math.max(0, fullGetsAfterSave.length - 1)

    const beforeExternal = await readFile(md.path)
    await appendFile(md.path, '\nexternal-change-keep\n')
    const conflicted = await saveApp(relay.base, 'markdown', md.path)
    const conflictError = String(conflicted.error ?? conflicted.message ?? '')
    const conflictedOk = conflicted.ok === false && /conflict/i.test(conflictError)
    shot = await page.screenshot({ type: 'png' }).catch(() => null)
    await page.close().catch(() => {})

    const recoverGets = []
    const page2 = await browser.newPage()
    page2.on('console', (msg) => logs.push(`[p2] ${msg.type()}: ${msg.text()}`))
    await collectFileGets(page2, recoverGets)
    await page2.goto(`${relay.base}/markdown/?control=1&open=${encodeURIComponent(`path:${md.path}`)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    const reopened = await waitReady(relay.base, md.path)
    const recovered = reopened.readiness === 'ready' ? await saveApp(relay.base, 'markdown', md.path) : { ok: false }
    const recoverFull = recoverGets.filter((row) => row.hasBase64)
    const recoveredText = await readFile(md.path, 'utf8')
    await page2.close().catch(() => {})

    const assertions = [
      assert('capture-mtime-no-full-get', gaps.captureMtimeUsesFullFileGet === false, false, gaps.captureMtimeUsesFullFileGet),
      assert('markdown-ready', opened.readiness === 'ready', 'ready', opened.readiness),
      assert('markdown-edit', toolOk(edited) || edited?.ok === true, true, edited),
      assert('first-save-ok', saved?.ok === true, true, saved),
      assert('single-full-file-get', fullGetsAfterSave.length === 1 && extraFullGets === 0, 1, {
        count: fullGetsAfterSave.length,
        extra: extraFullGets,
        gets: fullGetsAfterSave,
      }),
      assert('no-duplicate-full-get', extraFullGets === 0, 0, extraFullGets),
      assert('external-change-conflicts', conflictedOk, 'conflict', { ok: conflicted.ok, error: conflictError, raw: conflicted }),
      assert('reopen-ready', reopened.readiness === 'ready', 'ready', reopened.readiness),
      assert('reopen-single-full-get', recoverFull.length === 1, 1, recoverFull),
      assert('recover-save-ok', recovered?.ok === true, true, recovered),
      assert('recover-keeps-external-marker', recoveredText.includes('external-change-keep'), true, recoveredText.slice(0, 200)),
    ]
    const ok = assertions.every((row) => row.status === 'passed')
    const payload = {
      schema_version: 1,
      package: 'web-runtime-efficiency',
      uf: 'UF-001',
      branch: 'no-duplicate-read',
      status: ok ? 'passed' : 'failed',
      run_id: `wre-no-dup-${new Date().toISOString()}`,
      source_revisions: { plugin: gitHead(PLUGIN), engine: gitHead(ENGINE), engine_root: ENGINE },
      protocol: PROTOCOL,
      gaps,
      fixtures: [md],
      file_gets: fileGets,
      recover_file_gets: recoverGets,
      requests,
      opened,
      edited,
      saved,
      conflicted,
      reopened,
      recovered,
      cases: [{ id: 'no-duplicate-read-and-external-conflict', status: ok ? 'passed' : 'failed', assertions }],
    }
    await mkdir(join(outDir, 'phase-0'), { recursive: true })
    await writeFile(join(outDir, 'phase-0/task-2.log'), `${JSON.stringify(payload, null, 2)}\n`)
    if (shot) await writeFile(join(outDir, 'phase-0/task-2-screenshot.png'), shot)
    console.log(JSON.stringify(payload, null, 2))
    if (!ok) throw new Error('no-duplicate-read case failed')
    return payload
  } finally {
    await browser.close().catch(() => {})
    stopRelay(relay)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.all) {
    console.error(`--all not complete yet; implemented: ${IMPLEMENTED.join(', ')}`)
    process.exit(2)
  }
  const cases = [args.caseName]
  if (!args.mode || args.mode !== 'case' || !IMPLEMENTED.includes(args.caseName)) {
    console.error(`usage: node e2e-agent-runtime.mjs --case ${IMPLEMENTED.join('|')} [--out DIR]`)
    process.exit(2)
  }
  const outDir = args.outDir || EVIDENCE
  for (const name of cases) {
    if (name === 'baseline') await runBaseline(outDir)
    else if (name === 'no-duplicate-read') await runNoDuplicateRead(outDir)
  }
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
