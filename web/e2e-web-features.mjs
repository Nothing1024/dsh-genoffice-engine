#!/usr/bin/env node
/**
 * web-feature-completion harness.
 *   node web/e2e-web-features.mjs --case inventory|... [--out DIR]
 * ENGINE_ROOT selects the isolated merge tree.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ENGINE = resolve(process.env.ENGINE_ROOT || join(HERE, '..'))
const PLUGIN = resolve(process.env.PLUGIN_ROOT || '/Users/nothing/workspace/dsh/plugin/dsh-genoffice/plugin')
const INVENTORY = join(PLUGIN, 'docs/web-feature-completion/evidence/phase-0/capability-inventory.csv')
const CASES = ['inventory']

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

function probeDeps() {
  const sidecar = join(ENGINE, 'apps/sheets/native/xlsx-engine')
  const htmlPkg = join(ENGINE, 'apps/html/package.json')
  const htmlScripts = existsSync(htmlPkg) ? JSON.parse(readFileSync(htmlPkg, 'utf8')).scripts ?? {} : {}
  const server = readFileSync(join(ENGINE, 'web/server.mjs'), 'utf8')
  const pdfBridge = readFileSync(join(ENGINE, 'apps/pdf/src/renderer/web-bridge.ts'), 'utf8')
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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.mode || (args.mode === 'case' && !CASES.includes(args.caseName))) {
    console.error(`usage: node e2e-web-features.mjs --case ${CASES.join('|')} [--out DIR]`)
    process.exit(2)
  }
  const outDir = args.outDir
    ? resolve(process.cwd(), args.outDir)
    : join(PLUGIN, 'docs/web-feature-completion/evidence/phase-0')
  if (args.caseName === 'inventory' || args.all) await runInventory(outDir)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
