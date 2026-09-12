import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

export const HERE = fileURLToPath(new URL('.', import.meta.url))
export const ENGINE = resolve(process.env.ENGINE_ROOT || join(HERE, '..'))
export const PLUGIN = resolve(process.env.PLUGIN_ROOT || '/Users/nothing/workspace/dsh/plugin/dsh-genoffice/plugin')
export const EVIDENCE = join(PLUGIN, 'docs/web-runtime-efficiency/evidence')
export const DEFAULT_PORT = 18787
export const PROTOCOL = {
  version: 1,
  repeats: { markdown: 3, other: 2 },
  cold: 'new browser page against a freshly started relay; first sample of that app/size',
  warm: 'same relay process; a later page for the same fixture',
  sizes: {
    small: 'hand-built keep fixture or official generated sample',
    medium: 'markdown ~50KiB repeated paragraphs',
    large: 'markdown ~250KiB repeated paragraphs',
  },
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export function docIdFor(absPath) {
  return sha256(String(absPath))
}

export function gitHead(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

export function rssMb(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    return Number(out) / 1024
  } catch {
    return null
  }
}

export async function freePort(preferred) {
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

export async function until(fn, { timeout = 20_000, interval = 40 } = {}) {
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

export async function startRelay(port, extraEnv = {}) {
  return startRelayProcess([process.execPath, join(ENGINE, 'web/server.mjs')], port, extraEnv)
}

export async function startRelayViaNpm(port, script = 'web:serve', extraEnv = {}) {
  return startRelayProcess(['npm', 'run', script, '--silent'], port, extraEnv)
}

async function startRelayProcess(argv, port, extraEnv = {}) {
  const started = Date.now()
  const [cmd, ...args] = argv
  const child = spawn(cmd, args, {
    cwd: ENGINE,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  const onData = (chunk) => logs.push(String(chunk))
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  const base = `http://127.0.0.1:${port}`
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok), { timeout: 20_000 })
  return { child, base, port, logs, startMs: Date.now() - started, argv }
}


export function stopRelay(relay) {
  if (!relay?.child) return
  relay.child.kill('SIGTERM')
}

export async function post(base, url, body) {
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

export function toolOutput(result) {
  return String(result?.execution?.output ?? result?.output ?? result?.execution?.error ?? result?.error ?? result?.context ?? '')
}

export function toolOk(result) {
  return result?.ok === true && result?.execution?.isError !== true
}

export async function callTool(base, app, file, name, input = {}) {
  return post(base, `/api/control/${app}/${docIdFor(file)}/tool`, {
    call: { id: randomUUID(), name, input },
  })
}

export async function waitReady(base, path, timeout = 90_000) {
  return until(async () => {
    const data = await post(base, '/api/control/open', { path })
    if (data.readiness === 'ready' || data.readiness === 'error') return data
    return null
  }, { timeout, interval: 200 })
}

export async function contextApp(base, app, file) {
  return post(base, `/api/control/${app}/${docIdFor(file)}/context`, {})
}

export async function saveApp(base, app, file) {
  return post(base, `/api/control/${app}/${docIdFor(file)}/export`, { path: file })
}

function sheetIdFromContext(payload) {
  return toolOutput(payload).match(/\(id=([^,\s)]+)/)?.[1] || 'sheet-1'
}

export async function editFamily(base, app, file, marker) {
  if (app === 'markdown') {
    const first = await callTool(base, app, file, 'apply_ops', {
      ops: [{ op: 'insertContent', after: 1, markdown: marker }],
    })
    if (toolOk(first)) return first
    return callTool(base, app, file, 'insert_content', { afterIndex: -1, markdown: marker })
  }
  if (app === 'html') {
    return callTool(base, app, file, 'apply_ops', {
      ops: [{ op: 'str_replace', old: 'keep phrase', new: `keep phrase ${marker}` }],
    })
  }
  if (app === 'docs') {
    const first = await callTool(base, app, file, 'insert_content', {
      afterBlockIndex: -1,
      html: `<p>${marker}</p>`,
    })
    if (toolOk(first)) return first
    return callTool(base, app, file, 'replace_blocks', {
      startBlockIndex: 0,
      endBlockIndex: 0,
      html: `<p>${marker}</p>`,
    })
  }
  if (app === 'sheets') {
    const sheetId = sheetIdFromContext(await contextApp(base, app, file))
    return callTool(base, app, file, 'propose_operations', {
      summary: `write ${marker}`,
      operations: [{ op: 'set_cell', sheetId, address: 'A1', value: marker }],
    })
  }
  if (app === 'slides') {
    const outline = await callTool(base, app, file, 'read_slide', { slideIndex: 0 })
    const el = toolOutput(outline).match(/\b(e_[a-zA-Z0-9]+)\b/)?.[1]
    if (!el) return { ok: false, error: 'no element', outline }
    return callTool(base, app, file, 'apply_ops', {
      ops: [{ op: 'setText', target: { slide: 0, el }, paragraphs: [{ runs: [{ text: marker }] }] }],
    })
  }
  if (app === 'pdf') {
    const ctx = await contextApp(base, app, file)
    return { ok: ctx.ok !== false, execution: { output: toolOutput(ctx), mutated: false, summary: 'pdf-context' }, context: ctx }
  }
  throw new Error(`unknown app ${app}`)
}

export function probeGaps() {
  const pkg = JSON.parse(readFileSync(join(ENGINE, 'package.json'), 'utf8'))
  const scripts = pkg.scripts ?? {}
  const server = readFileSync(join(ENGINE, 'web/server.mjs'), 'utf8')
  const mdControl = readFileSync(join(ENGINE, 'apps/markdown/src/renderer/control.ts'), 'utf8')
  const pluginPkg = JSON.parse(readFileSync(join(PLUGIN, 'packages/tab-genoffice/package.json'), 'utf8'))
  const tools = readFileSync(join(PLUGIN, 'packages/tab-genoffice/src/host/tools.ts'), 'utf8')
  const captureMtimeUsesFile = /fetch\(`\/api\/file\?path=/.test(mdControl)
  return {
    engineHead: gitHead(ENGINE),
    pluginHead: gitHead(PLUGIN),
    node: process.version,
    npm: execFileSync('npm', ['-v'], { encoding: 'utf8' }).trim(),
    platform: `${process.platform} ${process.arch}`,
    chromium: chromium.executablePath(),
    chromiumExists: existsSync(chromium.executablePath()),
    scripts: {
      web: scripts.web ?? null,
      webServe: scripts['web:serve'] ?? null,
      webBuild: scripts['web:build'] ?? null,
      open: scripts.open ?? null,
    },
    healthReadyAnyLive: /ready:\s*live\.length\s*>\s*0/.test(server),
    hasDiscoveryRoute: /\/api\/discover/.test(server) || /\/api\/capabilities/.test(server),
    captureMtimeUsesFullFileGet: captureMtimeUsesFile,
    hasSdk: existsSync(join(ENGINE, 'web/sdk')) || existsSync(join(ENGINE, 'packages/agent-sdk')),
    hasCli: existsSync(join(ENGINE, 'web/agent-cli.mjs')),
    hasHeadlessManager: /headless/.test(server),
    pluginHasDshTools: Boolean(pluginPkg.devDependencies?.['@deepseek-ai/dsh-tools']),
    pluginHasMcp: JSON.stringify(pluginPkg).includes('mcp'),
    createControlToolsStatic: /export function createControlTools/.test(tools),
    htmlPresent: existsSync(join(ENGINE, 'apps/html/src')),
  }
}

export async function createFixtures(workDir) {
  await mkdir(workDir, { recursive: true })
  const fixtures = []
  const add = async (app, size, dest, bytes) => {
    fixtures.push({
      app,
      size,
      path: dest,
      bytes: bytes.length,
      sha256: sha256(bytes),
    })
    return dest
  }

  const mdSmall = join(workDir, 'md-small.md')
  const smallBody = '# WreKeep\n\nkeep phrase\n'
  await writeFile(mdSmall, smallBody)
  await add('markdown', 'small', mdSmall, Buffer.from(smallBody))

  const mdMedium = join(workDir, 'md-medium.md')
  const mediumBody = `# WreMedium\n\nkeep phrase\n\n${'paragraph keep. '.repeat(1800)}\n`
  await writeFile(mdMedium, mediumBody)
  await add('markdown', 'medium', mdMedium, Buffer.from(mediumBody))

  const mdLarge = join(workDir, 'md-large.md')
  const largeBody = `# WreLarge\n\nkeep phrase\n\n${'paragraph keep. '.repeat(9000)}\n`
  await writeFile(mdLarge, largeBody)
  await add('markdown', 'large', mdLarge, Buffer.from(largeBody))

  const htmlSmall = join(workDir, 'html-small.html')
  const htmlBody = '<!doctype html><html><head><meta charset="utf-8"><title>WreKeep</title></head><body><h1>WreKeep</h1><p>keep phrase</p></body></html>\n'
  await writeFile(htmlSmall, htmlBody)
  await add('html', 'small', htmlSmall, Buffer.from(htmlBody))

  const copies = [
    ['docs', 'small', join(ENGINE, 'fixtures/generated/simple.docx'), join(workDir, 'docs-small.docx')],
    ['sheets', 'small', join(ENGINE, 'apps/sheets/fixtures/generated/compatibility-basic.xlsx'), join(workDir, 'sheets-small.xlsx')],
    ['slides', 'small', join(ENGINE, 'fixtures/generated/sample.pptx'), join(workDir, 'slides-small.pptx')],
    ['pdf', 'small', join(ENGINE, 'fixtures/generated/simple.pdf'), join(workDir, 'pdf-small.pdf')],
  ]
  for (const [app, size, src, dest] of copies) {
    if (!existsSync(src)) throw new Error(`missing fixture ${src}`)
    await copyFile(src, dest)
    await add(app, size, dest, await readFile(dest))
  }
  return fixtures
}

export async function measureSample({ relay, browser, app, file, kind, marker }) {
  const page = await browser.newPage()
  const fileGets = []
  const requests = []
  page.on('request', (req) => {
    if (req.url().includes('/api/')) requests.push({ method: req.method(), url: req.url() })
  })
  page.on('response', async (res) => {
    try {
      if (res.url().includes('/api/file') && res.request().method() === 'GET') {
        const body = await res.body()
        fileGets.push({ bytes: body.length, url: res.url() })
      }
    } catch {
      /* ignore */
    }
  })
  const t0 = Date.now()
  await page.goto(`${relay.base}/${app}/?control=1&open=${encodeURIComponent(`path:${file}`)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  const tNav = Date.now()
  const opened = await waitReady(relay.base, file)
  const tReady = Date.now()
  const context = opened.readiness === 'ready' ? await contextApp(relay.base, app, file) : { ok: false, skipped: true }
  const tContext = Date.now()
  const edited = opened.readiness === 'ready' ? await editFamily(relay.base, app, file, marker) : { ok: false, skipped: true }
  const tEdit = Date.now()
  const saved = opened.readiness === 'ready' && app !== 'pdf' ? await saveApp(relay.base, app, file) : { ok: opened.readiness === 'ready', skipped: app === 'pdf' }
  const tSave = Date.now()
  const shot = await page.screenshot({ type: 'png' }).catch(() => null)
  await page.close().catch(() => {})
  const getBytes = fileGets.reduce((sum, row) => sum + row.bytes, 0)
  return {
    app,
    kind,
    file,
    ok: opened.readiness === 'ready' && (app === 'pdf' || toolOk(edited) || edited?.ok === true) && saved?.ok !== false,
    readiness: opened.readiness,
    openError: opened.error ?? null,
    editOk: toolOk(edited) || edited?.ok === true,
    saveOk: saved?.ok !== false,
    timings_ms: {
      navigate: tNav - t0,
      ready: tReady - tNav,
      context: tContext - tReady,
      edit: tEdit - tContext,
      save: tSave - tEdit,
      total: tSave - t0,
    },
    file_gets: fileGets.length,
    file_get_bytes: getBytes,
    duplicate_full_file_get: fileGets.length >= 2,
    api_requests: requests.length,
    rss_mb: rssMb(relay.child.pid),
    contextChars: toolOutput(context).length,
    screenshotBytes: shot?.length ?? 0,
  }
}

export function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`)
}

export { chromium, existsSync, readFileSync, statSync, execFileSync }
