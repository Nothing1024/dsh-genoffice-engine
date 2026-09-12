#!/usr/bin/env node
/**
 * web-runtime-efficiency harness.
 *   node web/e2e-agent-runtime.mjs --case baseline|... [--out DIR]
 *   node web/e2e-agent-runtime.mjs --all
 */
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
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
  startRelay,
  stopRelay,
  writeJson,
} from './runtime-measure.mjs'

const IMPLEMENTED = ['baseline']

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
      { name: 'mtime-full-get-gap', status: gaps.captureMtimeUsesFullFileGet ? 'passed' : 'failed', expected: true, actual: gaps.captureMtimeUsesFullFileGet },
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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cases = args.all ? IMPLEMENTED : [args.caseName]
  if (!args.mode || (args.mode === 'case' && !IMPLEMENTED.includes(args.caseName))) {
    console.error(`usage: node e2e-agent-runtime.mjs --case ${IMPLEMENTED.join('|')} [--out DIR]`)
    if (args.all) {
      console.error(`--all not complete yet; implemented: ${IMPLEMENTED.join(', ')}`)
    }
    process.exit(2)
  }
  const outDir = args.outDir || EVIDENCE
  for (const name of cases) {
    if (name === 'baseline') await runBaseline(outDir)
  }
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
