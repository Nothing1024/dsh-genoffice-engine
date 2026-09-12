#!/usr/bin/env node
/**
 * web-runtime-efficiency benchmark.
 *   node web/bench-agent-runtime.mjs --before|--after|--compare [--out DIR]
 */
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
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

function parseArgs(argv) {
  const out = { phase: null, outDir: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--before') out.phase = 'before'
    else if (arg === '--after') out.phase = 'after'
    else if (arg === '--compare') out.phase = 'compare'
    else if (arg === '--out') out.outDir = argv[++i]
  }
  return out
}

function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

function plan(fixtures) {
  const rows = []
  for (const fixture of fixtures) {
    const repeats = fixture.app === 'markdown' ? PROTOCOL.repeats.markdown : PROTOCOL.repeats.other
    for (let i = 0; i < repeats; i++) {
      rows.push({ fixture, kind: i === 0 ? 'cold' : 'warm', index: i })
    }
  }
  return rows
}

async function runPhase(phase, outDir) {
  const workDir = join(outDir, `phase-0/work-bench-${phase}`)
  const fixtures = await createFixtures(workDir)
  const gaps = probeGaps()
  const port = await freePort(DEFAULT_PORT)
  const relay = await startRelay(port)
  const browser = await chromium.launch({ headless: true })
  const samples = []
  try {
    for (const row of plan(fixtures)) {
      const sample = await measureSample({
        relay,
        browser,
        app: row.fixture.app,
        file: row.fixture.path,
        kind: row.kind,
        marker: `Wre${phase}${row.index}`,
      })
      samples.push({
        ...sample,
        size: row.fixture.size,
        fixtureSha: row.fixture.sha256,
        fixtureBytes: row.fixture.bytes,
        index: row.index,
      })
    }
  } finally {
    await browser.close().catch(() => {})
    stopRelay(relay)
  }
  const payload = {
    schema_version: 1,
    package: 'web-runtime-efficiency',
    uf: 'UF-001',
    branch: phase,
    status: samples.some((row) => row.ok) ? 'passed' : 'failed',
    run_id: `wre-bench-${phase}-${new Date().toISOString()}`,
    source_revisions: { plugin: gitHead(PLUGIN), engine: gitHead(ENGINE), engine_root: ENGINE },
    protocol: PROTOCOL,
    gaps,
    fixtures,
    samples,
    summary: summarize(samples),
  }
  const dest = join(outDir, `phase-0/bench-${phase}.json`)
  writeJson(dest, payload)
  writeJson(join(outDir, 'phase-0/task-1-bench.log'), payload)
  console.log(JSON.stringify({ dest, status: payload.status, samples: samples.length, summary: payload.summary }, null, 2))
  if (payload.status !== 'passed') throw new Error(`${phase} bench produced no successful samples`)
  return payload
}

function summarize(samples) {
  const byKey = {}
  for (const sample of samples) {
    const key = `${sample.app}:${sample.size}:${sample.kind}`
    const bucket = byKey[key] || (byKey[key] = [])
    bucket.push(sample)
  }
  const rows = []
  for (const [key, bucket] of Object.entries(byKey)) {
    const totals = bucket.map((row) => row.timings_ms.total)
    rows.push({
      key,
      n: bucket.length,
      ok: bucket.filter((row) => row.ok).length,
      p50_total_ms: percentile(totals, 50),
      p95_total_ms: percentile(totals, 95),
      file_gets_max: Math.max(...bucket.map((row) => row.file_gets)),
      file_get_bytes_max: Math.max(...bucket.map((row) => row.file_get_bytes)),
      duplicate_full_file_get: bucket.some((row) => row.duplicate_full_file_get),
    })
  }
  return rows
}

function compare(outDir) {
  const beforePath = join(outDir, 'phase-0/bench-before.json')
  const afterPath = join(outDir, 'phase-0/bench-after.json')
  if (!existsSync(beforePath)) throw new Error(`missing ${beforePath}`)
  if (!existsSync(afterPath)) {
    const payload = {
      schema_version: 1,
      package: 'web-runtime-efficiency',
      status: 'blocked',
      reason: 'after baseline not collected yet; Task 13 writes bench-after.json under the same protocol',
      before: beforePath,
    }
    writeJson(join(outDir, 'phase-0/bench-compare.json'), payload)
    console.log(JSON.stringify(payload, null, 2))
    throw new Error(payload.reason)
  }
  const before = JSON.parse(readFileSync(beforePath, 'utf8'))
  const after = JSON.parse(readFileSync(afterPath, 'utf8'))
  const sameProtocol = before.protocol?.version === after.protocol?.version
  const payload = {
    schema_version: 1,
    package: 'web-runtime-efficiency',
    uf: 'UF-001',
    branch: 'compare',
    status: sameProtocol ? 'passed' : 'failed',
    sameProtocol,
    beforeHead: before.source_revisions,
    afterHead: after.source_revisions,
    beforeSummary: before.summary,
    afterSummary: after.summary,
  }
  writeJson(join(outDir, 'phase-0/bench-compare.json'), payload)
  console.log(JSON.stringify(payload, null, 2))
  if (!sameProtocol) throw new Error('compare protocol mismatch')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.phase) {
    console.error('usage: node bench-agent-runtime.mjs --before|--after|--compare [--out DIR]')
    process.exit(2)
  }
  const outDir = args.outDir || EVIDENCE
  if (args.phase === 'compare') compare(outDir)
  else await runPhase(args.phase, outDir)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
