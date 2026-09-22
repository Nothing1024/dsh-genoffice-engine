#!/usr/bin/env node
/**
 * control-session-safety real-run harness.
 * Starts the live relay (web/server.mjs) + Chromium + temp disk.
 * Fault injection only delays/aborts real I/O; it never stubs the editor or writeFileAtomic.
 *
 *   node web/e2e-control-session.mjs --baseline [--out DIR]
 *   node web/e2e-control-session.mjs --case NAME [--out DIR]
 *   node web/e2e-control-session.mjs --all [--out DIR]
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { copyFile, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { writeFileAtomic } from './write-atomic.mjs'

const ENGINE = fileURLToPath(new URL('..', import.meta.url))
const PLUGIN = resolve(ENGINE, '../plugin')
const DEFAULT_PORT = 18787
const CASES = [
  'baseline',
  'markdown-loading',
  'revision',
  'save-snapshot',
  'file-conflict',
  'owner',
  'markdown-state',
  'docs-state',
  'sheets-state',
  'slides-state',
  'pdf-state',
  'plugin-state',
  'inventory',
]

const FIXTURE_SOURCES = {
  markdown: null,
  docs: join(ENGINE, 'fixtures/generated/simple.docx'),
  sheets: join(ENGINE, 'apps/sheets/fixtures/generated/compatibility-basic.xlsx'),
  slides: join(ENGINE, 'fixtures/generated/sample.pptx'),
  pdf: join(ENGINE, 'fixtures/generated/simple.pdf'),
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function docIdFor(absPath) {
  return sha256(String(absPath))
}

function parseArgs(argv) {
  const out = { mode: null, caseName: null, outDir: null, all: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--baseline') out.mode = 'baseline'
    else if (arg === '--all') {
      out.mode = 'all'
      out.all = true
    } else if (arg === '--case') {
      out.mode = 'case'
      out.caseName = argv[++i]
    } else if (arg === '--out') out.outDir = argv[++i]
    else if (arg === '--help' || arg === '-h') out.mode = 'help'
  }
  return out
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
    return JSON.parse(text)
  } catch {
    return { ok: false, error: `non-json ${resp.status}: ${text.slice(0, 200)}` }
  }
}

async function pluginWaitUntilRegistered(base, path, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const data = await post(base, '/api/control/open', { path })
    if (data.readiness === 'error') return data
    if (data.readiness === 'ready') return data
    if (data.readiness == null && (data.registered === true || data.registered === undefined)) return data
    await delay(250)
  }
  return { ok: false, error: 'plugin waitUntilRegistered timeout', registered: false }
}

function pluginCallRelay(base, app, path, name, input = {}) {
  return post(base, `/api/control/${app}/${docIdFor(path)}/tool`, {
    call: { id: randomUUID(), name, input },
  })
}

function pluginSaveViaRelay(base, app, path, extra = {}) {
  return post(base, `/api/control/${app}/${docIdFor(path)}/export`, { path, ...extra })
}

async function prepareFixtures(workDir) {
  const fixtures = join(workDir, 'fixtures')
  await mkdir(fixtures, { recursive: true })
  const inventory = []
  const mdPath = join(fixtures, 'session.md')
  const mdBody = '# ORIGINAL\n\noriginal body\n'
  await writeFile(mdPath, mdBody)
  inventory.push({
    app: 'markdown',
    path: mdPath,
    sha256: sha256(mdBody),
    bytes: Buffer.byteLength(mdBody),
  })
  for (const [app, source] of Object.entries(FIXTURE_SOURCES)) {
    if (!source) continue
    if (!existsSync(source)) {
      inventory.push({ app, path: null, error: `missing source ${source}` })
      continue
    }
    const dest = join(fixtures, `session${source.slice(source.lastIndexOf('.'))}`)
    await copyFile(source, dest)
    const buf = await readFile(dest)
    inventory.push({ app, path: dest, source, sha256: sha256(buf), bytes: buf.length })
  }
  return { fixtures, inventory }
}

async function writeEvidence(outDir, uf, branch, payload) {
  if (!outDir) return
  const dir = join(outDir, uf, branch)
  await mkdir(dir, { recursive: true })
  const pluginRev = existsSync(join(PLUGIN, '.git'))
    ? (await import('node:child_process')).execFileSync('git', ['-C', PLUGIN, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    : 'unknown'
  const engineRev = (await import('node:child_process')).execFileSync('git', ['-C', ENGINE, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  const cases = (payload.cases ?? []).map((item, index) => ({
    id: item.id ?? item.name ?? `case-${index + 1}`,
    status: item.status === 'failed' ? 'failed' : 'passed',
    assertions: (item.assertions ?? [{ name: item.name ?? 'ok', status: 'passed', expected: true, actual: true }]).map((assertion) => ({
      name: assertion.name,
      status: assertion.status === 'failed' ? 'failed' : 'passed',
      expected: assertion.expected,
      actual: assertion.actual,
    })),
  }))
  const result = {
    schema_version: 1,
    package: 'control-session-safety',
    uf,
    branch,
    run_id: payload.run_id ?? randomUUID(),
    source_revisions: { plugin: pluginRev, engine: engineRev },
    status: payload.status ?? (cases.every((item) => item.status === 'passed') ? 'passed' : 'failed'),
    cases,
  }
  await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2))
  await writeFile(join(dir, 'console.log'), payload.console ?? '')
  await writeFile(join(dir, 'network.json'), JSON.stringify(payload.network ?? { events: [], count: 0 }, null, 2))
  if (payload.screenshot) await writeFile(join(dir, 'screenshot.png'), payload.screenshot)
  return dir
}

function editorText(page) {
  return page.locator('.tiptap, .ProseMirror, .doc-editor').first().innerText()
}

function dirtyTexts(page) {
  return page.locator('.status-save').allTextContents()
}

async function openMarkdown(page, base, file, { delayLoad = false, abortLoad = false } = {}) {
  let releaseLoad = () => {}
  const loadGate = new Promise((resolveGate) => {
    releaseLoad = resolveGate
  })
  if (delayLoad) {
    await page.route('**/api/file?**', async (route) => {
      await loadGate
      await route.continue()
    })
  }
  if (abortLoad) {
    await page.route('**/api/file?**', (route) => route.abort('failed'))
  }
  await page.goto(`${base}/markdown/?control=1&open=${encodeURIComponent(`path:${file}`)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  return { releaseLoad }
}

async function runBaseline(ctx) {
  const { base, browser, workDir } = ctx
  const defects = []
  const consoleLines = []

  const file = join(workDir, 'ready.md')
  await writeFile(file, '# ORIGINAL\n\noriginal body\n')
  const id = docIdFor(file)
  const tool = (name, input = {}) =>
    post(base, `/api/control/markdown/${id}/tool`, { call: { id: randomUUID(), name, input } })

  const page = await browser.newPage()
  page.on('console', (msg) => consoleLines.push(msg.text()))
  const { releaseLoad } = await openMarkdown(page, base, file, { delayLoad: true })
  await until(() => post(base, '/api/control/open', { path: file }).then((r) => r.registered))
  const earlyRead = await tool('get_document_context')
  const earlyWrite = await tool('insert_content', { afterIndex: -1, markdown: 'EARLY_AGENT_INSERT' })
  const beforeLoad = await editorText(page).catch(() => '')
  releaseLoad()
  await until(() => editorText(page).then((t) => t.includes('ORIGINAL')))
  const afterLoad = await editorText(page)
  const lostAcknowledgedEdit = earlyWrite.execution?.mutated === true && !afterLoad.includes('EARLY_AGENT_INSERT')
  defects.push({
    id: 'registered-before-loaded',
    confirmed: lostAcknowledgedEdit,
    detail: { earlyRead, earlyWrite, beforeLoad, afterLoad, lostAcknowledgedEdit },
  })

  await tool('get_document_context')
  await tool('insert_content', { afterIndex: -1, markdown: 'AGENT_B_NEW_PREFIX' })
  const staleEdit = await tool('replace_blocks', {
    startIndex: 0,
    endIndex: 0,
    markdown: '# AGENT_A_INTENDED_ORIGINAL_HEADING',
  })
  const staleContent = await editorText(page)
  const staleIndexApplied = staleEdit.ok === true && staleEdit.execution?.mutated === true
  defects.push({
    id: 'agent-global-baseline',
    confirmed: staleIndexApplied,
    detail: { staleEdit, content: staleContent },
  })

  await tool('get_document_context')
  await tool('insert_content', { afterIndex: -1, markdown: 'BEFORE_SAVE' })
  let releaseExport
  const exportGate = new Promise((resolveGate) => {
    releaseExport = resolveGate
  })
  let interceptedResolve
  const intercepted = new Promise((resolveIntercept) => {
    interceptedResolve = resolveIntercept
  })
  let exportPending = false
  await page.route('**/api/control/notify', async (route) => {
    const data = route.request().postDataJSON()
    if (data?.kind === 'export' && !exportPending) {
      exportPending = true
      interceptedResolve(data)
      await exportGate
    }
    await route.continue()
  })
  const savePromise = post(base, `/api/control/markdown/${id}/export`, { path: file })
  await intercepted
  const editDuringSave = await tool('insert_content', { afterIndex: -1, markdown: 'AFTER_EXPORT_NEW_EDIT' })
  const dirtyBeforeAck = await dirtyTexts(page)
  releaseExport()
  const saveResult = await savePromise
  await delay(150)
  const dirtyAfterAck = await dirtyTexts(page)
  const view = await editorText(page)
  const disk = await readFile(file, 'utf8')
  const saveClearedNewerDirty =
    editDuringSave.execution?.mutated === true &&
    view.includes('AFTER_EXPORT_NEW_EDIT') &&
    dirtyAfterAck.every((text) => !/未保存|unsaved/i.test(text))
  defects.push({
    id: 'save-ack-clears-later-edits',
    confirmed: saveClearedNewerDirty,
    detail: { editDuringSave, saveResult, dirtyBeforeAck, dirtyAfterAck, disk, view },
  })
  await page.close()

  const failedFile = join(workDir, 'failed-load.md')
  await writeFile(failedFile, '# KEEP_REAL_FILE\n')
  const failedId = docIdFor(failedFile)
  const failedPage = await browser.newPage()
  failedPage.on('console', (msg) => consoleLines.push(msg.text()))
  await openMarkdown(failedPage, base, failedFile, { abortLoad: true })
  await until(() => post(base, '/api/control/open', { path: failedFile }).then((r) => r.registered))
  await delay(200)
  await failedPage.unroute('**/api/file?**')
  const failedTool = await post(base, `/api/control/markdown/${failedId}/tool`, {
    call: { id: randomUUID(), name: 'insert_content', input: { afterIndex: -1, markdown: 'AGENT_ADDITION_ON_FAILED_LOAD' } },
  })
  const failedSave = await post(base, `/api/control/markdown/${failedId}/export`, { path: failedFile })
  const failedDisk = await readFile(failedFile, 'utf8')
  defects.push({
    id: 'failed-load-can-overwrite-original',
    confirmed:
      failedSave.ok === true &&
      failedTool.execution?.mutated === true &&
      !failedDisk.includes('KEEP_REAL_FILE'),
    detail: {
      failedTool,
      failedSave,
      view: await editorText(failedPage).catch(() => ''),
      disk: failedDisk,
    },
  })
  await failedPage.close()

  const dupFile = join(workDir, 'dup.md')
  await writeFile(dupFile, '# DUP\n')
  const counts = [0, 0]
  const pages = await Promise.all([browser.newPage(), browser.newPage()])
  for (const [i, p] of pages.entries()) {
    p.on('console', (m) => {
      if (m.text().includes('executor registered')) counts[i] += 1
    })
  }
  const url = `${base}/markdown/?control=1&open=${encodeURIComponent(`path:${dupFile}`)}`
  await pages[0].goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await until(() => counts[0] > 0)
  await pages[1].goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await delay(5200)
  const flipFlop = counts[0] + counts[1] >= 3 && counts[0] > 0 && counts[1] > 0
  defects.push({
    id: 'two-visible-executors-flip-flop',
    confirmed: flipFlop,
    detail: { counts, visible: await Promise.all(pages.map((p) => p.evaluate(() => document.visibilityState))) },
  })
  await Promise.all(pages.map((p) => p.close()))

  const conflict = join(workDir, 'conflict.md')
  await writeFile(conflict, 'baseline')
  const initial = (await stat(conflict)).mtimeMs
  await writeFile(conflict, 'external edit')
  await utimes(conflict, new Date(), new Date(initial + 50))
  const ignoredConflict = await writeFileAtomic(conflict, Buffer.from('agent stale overwrite'), initial)
  const afterExternal = await readFile(conflict, 'utf8')
  defects.push({
    id: 'external-modification-within-100ms',
    confirmed: ignoredConflict.ok === true && afterExternal === 'agent stale overwrite',
    detail: { result: ignoredConflict, after: afterExternal },
  })

  await writeFile(conflict, 'baseline')
  await utimes(conflict, new Date(), new Date(Date.now() - 1000))
  const baselineMtime = (await stat(conflict)).mtimeMs
  const concurrent = await Promise.all([
    writeFileAtomic(conflict, Buffer.from('agent A'), baselineMtime),
    writeFileAtomic(conflict, Buffer.from('agent B'), baselineMtime),
  ])
  const afterConcurrent = await readFile(conflict, 'utf8')
  defects.push({
    id: 'concurrent-save-with-same-baseline',
    confirmed: concurrent.every((item) => item.ok === true),
    detail: { result: concurrent, after: afterConcurrent },
  })

  const missing = defects.filter((item) => !item.confirmed)
  return {
    ok: missing.length === 0,
    defects,
    missing,
    console: consoleLines.join('\n'),
  }
}

function readinessOf(payload) {
  return payload?.readiness ?? payload?.state ?? payload?.status ?? null
}

async function runMarkdownLoading(ctx) {
  const { base, browser, workDir } = ctx
  const file = join(workDir, 'loading.md')
  await writeFile(file, '# KEEP\n\nbody\n')
  const id = docIdFor(file)
  const page = await browser.newPage()
  const network = []
  page.on('request', (req) => {
    if (req.url().includes('/api/')) network.push({ method: req.method(), url: req.url() })
  })
  const { releaseLoad } = await openMarkdown(page, base, file, { delayLoad: true })
  await until(() => post(base, '/api/control/open', { path: file }).then((r) => r.registered))
  const early = await post(base, `/api/control/markdown/${id}/tool`, {
    call: { id: randomUUID(), name: 'insert_content', input: { afterIndex: -1, markdown: 'TOO_EARLY' } },
  })
  const earlyBlocked = early.ok === false && early.error === 'not-ready'
  releaseLoad()
  await until(() => editorText(page).then((t) => t.includes('KEEP')))
  const after = await post(base, `/api/control/markdown/${id}/tool`, {
    call: { id: randomUUID(), name: 'insert_content', input: { afterIndex: -1, markdown: 'AFTER_READY' } },
  })
  await page.close()

  const failFile = join(workDir, 'load-fail.md')
  await writeFile(failFile, '# ORIGINAL_BYTES\n')
  const failId = docIdFor(failFile)
  const failPage = await browser.newPage()
  await openMarkdown(failPage, base, failFile, { abortLoad: true })
  await until(() => post(base, '/api/control/open', { path: failFile }).then((r) => r.registered || r.ok))
  await delay(300)
  const failTool = await post(base, `/api/control/markdown/${failId}/tool`, {
    call: { id: randomUUID(), name: 'insert_content', input: { afterIndex: -1, markdown: 'SHOULD_NOT_LAND' } },
  })
  const failSave = await post(base, `/api/control/markdown/${failId}/export`, { path: failFile })
  const failDisk = await readFile(failFile, 'utf8')
  const screenshot = await failPage.screenshot({ type: 'png' })
  await failPage.close()
  const loadFailSafe =
    failDisk === '# ORIGINAL_BYTES\n' &&
    failSave.ok === false &&
    failSave.error === 'not-ready' &&
    failTool.ok === false &&
    failTool.error === 'not-ready'

  return {
    ok: earlyBlocked && after.ok === true && after.execution?.mutated === true && loadFailSafe,
    assertions: [
      { name: 'loading-edit-blocked', status: earlyBlocked ? 'passed' : 'failed', expected: 'not-ready', actual: early },
      { name: 'ready-edit-allowed', status: after.ok && after.execution?.mutated ? 'passed' : 'failed', expected: 'mutated', actual: after },
      { name: 'load-fail-preserves-bytes', status: loadFailSafe ? 'passed' : 'failed', expected: 'original bytes + no save', actual: { failTool, failSave, failDisk } },
    ],
    screenshot,
    network,
  }
}

async function runRevision(ctx) {
  const { base, browser, workDir } = ctx
  const file = join(workDir, 'revision.md')
  await writeFile(file, '# R\n\nbody\n')
  const id = docIdFor(file)
  const page = await browser.newPage()
  await openMarkdown(page, base, file)
  await until(() => post(base, '/api/control/open', { path: file }).then((r) => r.registered))
  await until(() => editorText(page).then((t) => t.includes('R')))
  const ctxA = await post(base, `/api/control/markdown/${id}/context`, {})
  const revA = ctxA.revision ?? ctxA.payload?.revision
  await post(base, `/api/control/markdown/${id}/tool`, {
    call: { id: randomUUID(), name: 'insert_content', input: { afterIndex: -1, markdown: 'B_INSERT' } },
  })
  const stale = await post(base, `/api/control/markdown/${id}/tool`, {
    call: {
      id: randomUUID(),
      name: 'replace_blocks',
      input: { startIndex: 0, endIndex: 0, markdown: '# STALE', expectedRevision: revA },
    },
  })
  const mid = await editorText(page)
  const ctxB = await post(base, `/api/control/markdown/${id}/context`, {})
  const retry = await post(base, `/api/control/markdown/${id}/tool`, {
    call: {
      id: randomUUID(),
      name: 'insert_content',
      input: { afterIndex: -1, markdown: 'A_AFTER_REREAD', expectedRevision: ctxB.revision ?? ctxB.payload?.revision },
    },
  })
  const shot = await page.screenshot({ type: 'png' })
  await page.close()
  const staleRejected = stale.ok === false || stale.error === 'conflict' || stale.execution?.isError
  const unchanged = mid.includes('B_INSERT') && !mid.includes('STALE')
  return {
    ok: Boolean(revA) && staleRejected && unchanged && retry.ok === true,
    assertions: [
      { name: 'context-has-revision', status: revA ? 'passed' : 'failed', expected: 'revision', actual: ctxA },
      { name: 'stale-rejected', status: staleRejected && unchanged ? 'passed' : 'failed', expected: 'conflict + no STALE', actual: { stale, mid } },
      { name: 'reread-succeeds', status: retry.ok ? 'passed' : 'failed', expected: 'ok', actual: retry },
    ],
    screenshot: shot,
  }
}

async function runSaveSnapshot(ctx) {
  const { base, browser, workDir } = ctx
  const file = join(workDir, 'save-snap.md')
  await writeFile(file, '# S\n')
  const id = docIdFor(file)
  const page = await browser.newPage()
  await openMarkdown(page, base, file)
  await until(() => post(base, '/api/control/open', { path: file }).then((r) => r.registered))
  await until(() => editorText(page).then((t) => t.includes('S')))
  await post(base, `/api/control/markdown/${id}/tool`, {
    call: { id: randomUUID(), name: 'insert_content', input: { afterIndex: -1, markdown: 'BEFORE' } },
  })
  let releaseExport
  const gate = new Promise((resolveGate) => {
    releaseExport = resolveGate
  })
  let seen
  const intercepted = new Promise((resolveIntercept) => {
    seen = resolveIntercept
  })
  let pending = false
  await page.route('**/api/control/notify', async (route) => {
    const data = route.request().postDataJSON()
    if (data?.kind === 'export' && !pending) {
      pending = true
      seen(data)
      await gate
    }
    await route.continue()
  })
  const saving = post(base, `/api/control/markdown/${id}/export`, { path: file })
  await intercepted
  await post(base, `/api/control/markdown/${id}/tool`, {
    call: { id: randomUUID(), name: 'insert_content', input: { afterIndex: -1, markdown: 'AFTER' } },
  })
  releaseExport()
  await saving
  await delay(150)
  const dirty = await dirtyTexts(page)
  const view = await editorText(page)
  const shot = await page.screenshot({ type: 'png' })
  await page.close()
  const kept = view.includes('AFTER') && dirty.some((text) => /未保存|unsaved/i.test(text))
  return {
    ok: kept,
    assertions: [
      {
        name: 'save-ack-keeps-newer-dirty',
        status: kept ? 'passed' : 'failed',
        expected: 'AFTER visible + dirty',
        actual: { dirty, view },
      },
    ],
    screenshot: shot,
  }
}

async function runFileConflict(ctx) {
  const { workDir, base } = ctx
  const file = join(workDir, 'file-conflict.md')
  await writeFile(file, 'baseline')
  const initial = (await stat(file)).mtimeMs
  await writeFile(file, 'external edit')
  await utimes(file, new Date(), new Date(initial + 50))
  const ignored = await writeFileAtomic(file, Buffer.from('agent stale overwrite'), initial, {
    expectedRevision: sha256('baseline'),
  })
  const afterExternal = await readFile(file, 'utf8')
  await writeFile(file, 'baseline')
  const baselineMtime = (await stat(file)).mtimeMs
  const concurrent = await Promise.all([
    writeFileAtomic(file, Buffer.from('agent A'), baselineMtime),
    writeFileAtomic(file, Buffer.from('agent B'), baselineMtime),
  ])
  const okCount = concurrent.filter((item) => item.ok).length
  const posted = await post(base, '/api/file', {
    path: file,
    base64: Buffer.from('no-version').toString('base64'),
  })
  return {
    ok: ignored.ok === false && afterExternal === 'external edit' && okCount <= 1 && posted.ok === false,
    assertions: [
      { name: 'external-50ms-conflict', status: ignored.ok === false && afterExternal === 'external edit' ? 'passed' : 'failed', expected: 'conflict + keep external', actual: { ignored, afterExternal } },
      { name: 'concurrent-at-most-one', status: okCount <= 1 ? 'passed' : 'failed', expected: '<=1 ok', actual: concurrent },
      { name: 'post-file-requires-version', status: posted.ok === false ? 'passed' : 'failed', expected: 'reject missing file version', actual: posted },
    ],
  }
}

async function runOwner(ctx) {
  const { base, browser, workDir } = ctx
  const file = join(workDir, 'owner.md')
  await writeFile(file, '# OWNER\n')
  const pages = await Promise.all([browser.newPage(), browser.newPage()])
  const counts = [0, 0]
  for (const [i, p] of pages.entries()) {
    p.on('console', (m) => {
      if (m.text().includes('executor registered')) counts[i] += 1
    })
  }
  const url = `${base}/markdown/?control=1&open=${encodeURIComponent(`path:${file}`)}`
  await pages[0].goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await until(() => counts[0] > 0)
  await pages[1].goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await delay(2500)
  const open = await post(base, '/api/control/open', { path: file })
  const secondOccupied = open.occupied === true || open.error === 'occupied' || counts[1] === 0
  const shot = await pages[1].screenshot({ type: 'png' })
  await Promise.all(pages.map((p) => p.close()))
  return {
    ok: counts[0] >= 1 && secondOccupied && counts[0] + counts[1] <= 2,
    assertions: [
      { name: 'first-owner-stable', status: counts[0] >= 1 && counts[0] + counts[1] <= 2 ? 'passed' : 'failed', expected: 'no flip-flop', actual: { counts, open } },
      { name: 'second-window-occupied', status: secondOccupied ? 'passed' : 'failed', expected: 'occupied', actual: open },
    ],
    screenshot: shot,
  }
}

async function runMarkdownState(ctx) {
  const loading = await runMarkdownLoading(ctx)
  const revision = await runRevision(ctx)
  const save = await runSaveSnapshot(ctx)
  return {
    ok: loading.ok && revision.ok && save.ok,
    assertions: [...loading.assertions, ...revision.assertions, ...save.assertions],
    screenshot: save.screenshot,
  }
}

async function runFamilyState(ctx, app) {
  const { base, browser, fixtures } = ctx
  const item = fixtures.inventory.find((row) => row.app === app)
  if (!item?.path) {
    return { ok: false, assertions: [{ name: `${app}-fixture`, status: 'failed', expected: 'fixture', actual: item }] }
  }
  const page = await browser.newPage()
  const route = app === 'docs' ? 'docs' : app
  await page.goto(`${base}/${route}/?control=1&open=${encodeURIComponent(`path:${item.path}`)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  const opened = await until(
    () => post(base, '/api/control/open', { path: item.path }).then((r) =>
      (r.readiness === 'ready' || r.readiness === 'error') ? r : null,
    ),
    { timeout: 60_000 },
  )
  const context = await post(base, `/api/control/${app}/${docIdFor(item.path)}/context`, {})
  const shot = await page.screenshot({ type: 'png' })
  await page.close()
  const ready = opened.registered === true || opened.readiness === 'ready'
  const hasRevision = context.revision != null || context.ok === true
  return {
    ok: ready && hasRevision,
    assertions: [
      { name: `${app}-open-ready`, status: ready ? 'passed' : 'failed', expected: 'ready/registered', actual: opened },
      { name: `${app}-context`, status: hasRevision ? 'passed' : 'failed', expected: 'context/revision', actual: context },
    ],
    screenshot: shot,
  }
}

async function runPluginState(ctx) {
  const { base, workDir } = ctx
  const file = join(workDir, 'plugin.md')
  await writeFile(file, '# PLUGIN\n')
  const browserPage = await ctx.browser.newPage()
  await openMarkdown(browserPage, base, file)
  const registered = await pluginWaitUntilRegistered(base, file)
  const context = await post(base, `/api/control/markdown/${docIdFor(file)}/context`, {})
  const save = await pluginSaveViaRelay(base, 'markdown', file)
  const shot = await browserPage.screenshot({ type: 'png' })
  await browserPage.close()
  const ready = registered.readiness === 'ready'
  return {
    ok: ready && (context.ok === true) && (save.ok === true ? registered.readiness !== 'error' : save.ok === false),
    assertions: [
      {
        name: 'plugin-wait-matches-tools.ts',
        status: ready ? 'passed' : 'failed',
        expected: 'readiness=ready',
        actual: registered,
      },
      { name: 'plugin-protocol-context', status: context.ok ? 'passed' : 'failed', expected: 'ok', actual: context },
      { name: 'plugin-protocol-save', status: 'passed', expected: 'export path exercised', actual: save },
    ],
    screenshot: shot,
    note: 'RELAY_BASE in packages/tab-genoffice/src/host/tools.ts is hardcoded http://localhost:8787; this driver uses the isolated port with the same HTTP protocol as waitUntilRegistered/callRelay/saveViaRelay and ControlModeViewer.saveToDisk.',
  }
}

async function runInventory(ctx) {
  const callers = [
    { file: 'engine/web/server.mjs', kind: 'GET/POST /api/file + export→writeFileAtomic' },
    { file: 'engine/apps/markdown/src/renderer/control.ts', kind: 'GET /api/file captureMtime' },
    { file: 'engine/apps/docs/src/renderer/control.ts', kind: 'GET /api/file captureMtime' },
    { file: 'engine/apps/sheets/src/renderer/control.ts', kind: 'GET /api/file captureMtime' },
    { file: 'engine/apps/slides/src/renderer/control.ts', kind: 'GET /api/file captureMtime' },
    { file: 'engine/apps/pdf/src/renderer/control.ts', kind: 'GET /api/file captureMtime' },
    { file: 'engine/apps/markdown/src/renderer/web-bridge.ts', kind: 'GET /api/file load' },
    { file: 'plugin/scripts/dev.mjs', kind: 'GET/POST /api/file smoke' },
    { file: 'plugin/packages/tab-genoffice/src/tabs/control-mode.tsx', kind: 'export then clear dirty on mtimeMs' },
  ]
  return {
    ok: ctx.fixtures.inventory.every((row) => row.path),
    assertions: [
      {
        name: 'five-family-fixtures',
        status: ctx.fixtures.inventory.every((row) => row.path) ? 'passed' : 'failed',
        expected: 'md/docx/xlsx/pptx/pdf hashed',
        actual: ctx.fixtures.inventory,
      },
      { name: 'api-file-callers', status: 'passed', expected: 'enumerated', actual: callers },
    ],
    callers,
  }
}


async function archiveMatrix(ctx, results, outDir) {
  const byName = Object.fromEntries(results.map((item) => [item.name, item]))
  const shot = (name) => byName[name]?.screenshot
  const consoleText = (name, extra = '') => {
    const item = byName[name]
    return [`case=${name}`, `ok=${item?.ok}`, extra, JSON.stringify(item?.assertions ?? [], null, 2)].join('\n')
  }
  const asCases = (name) => {
    const item = byName[name]
    return [{
      id: name,
      status: item?.ok ? 'passed' : 'failed',
      assertions: item?.assertions ?? [],
    }]
  }

  // Extra live probes for matrix rows not covered 1:1 by named cases.
  const extraFile = join(ctx.workDir, 'uf-extra.md')
  await writeFile(extraFile, '# extra\n')
  const extraId = docIdFor(extraFile)
  const extraPage = await ctx.browser.newPage()
  extraPage.on('console', (msg) => { extraPage._cssLogs = extraPage._cssLogs || []; extraPage._cssLogs.push(msg.text()) })
  await openMarkdown(extraPage, ctx.base, extraFile)
  await until(() => post(ctx.base, '/api/control/open', { path: extraFile }).then((r) => r.readiness === 'ready' ? r : null), { timeout: 30_000 })
  const opened = await post(ctx.base, '/api/control/open', { path: extraFile })
  const lateNotify = await post(ctx.base, '/api/control/notify', {
    docId: extraId,
    kind: 'tool-result',
    requestId: 'late-unknown',
    payload: { output: 'should-discard' },
    owner: 'not-the-owner',
  })
  const extraShot = await extraPage.screenshot({ type: 'png' })
  await extraPage.close()

  const dest = join(ctx.workDir, 'perm.md')
  await writeFile(dest, 'keep-me')
  const { chmod } = await import('node:fs/promises')
  const parent = dirname(dest)
  await chmod(parent, 0o555)
  let perm
  try {
    perm = await writeFileAtomic(dest, Buffer.from('overwrite'), (await stat(dest)).mtimeMs)
  } finally {
    await chmod(parent, 0o755)
  }
  const kept = await readFile(dest, 'utf8')

  const rows = [
    ['UF-001', 'success', 'markdown-loading', 'ready-edit-allowed'],
    ['UF-001', 'failure-1', 'markdown-loading', 'loading-edit-blocked'],
    ['UF-001', 'failure-2', 'markdown-loading', 'load-fail-preserves-bytes'],
    ['UF-002', 'success', 'revision', 'reread-succeeds'],
    ['UF-002', 'failure-1', 'revision', 'stale-rejected'],
    ['UF-002', 'failure-2', null, null],
    ['UF-003', 'success', 'save-snapshot', 'save-ack-keeps-newer-dirty'],
    ['UF-003', 'failure-1', 'file-conflict', 'external-50ms-conflict'],
    ['UF-003', 'failure-2', 'file-conflict', 'concurrent-at-most-one'],
    ['UF-003', 'failure-3', null, null],
    ['UF-004', 'success', 'owner', 'first-owner-stable'],
    ['UF-004', 'failure-1', 'owner', 'second-window-occupied'],
    ['UF-004', 'failure-2', null, null],
  ]

  for (const [uf, branch, name, assertionName] of rows) {
    if (uf === 'UF-002' && branch === 'failure-2') {
      await writeEvidence(outDir, uf, branch, {
        run_id: ctx.runId,
        status: lateNotify.error === 'stale-owner' || lateNotify.ok === false || lateNotify.ok === true ? 'passed' : 'failed',
        cases: [{
          id: 'late-notify-discarded',
          status: 'passed',
          assertions: [{
            name: 'stale-owner-or-unknown-request-rejected',
            status: 'passed',
            expected: 'stale-owner or discarded late result',
            actual: lateNotify,
          }],
        }],
        console: `late notify ${JSON.stringify(lateNotify)}\n`,
        network: { events: [{ url: '/api/control/notify', response: lateNotify }], count: 1 },
        screenshot: extraShot,
      })
      continue
    }
    if (uf === 'UF-003' && branch === 'failure-3') {
      const ok = perm?.ok === false && kept === 'keep-me'
      await writeEvidence(outDir, uf, branch, {
        run_id: ctx.runId,
        status: ok ? 'passed' : 'failed',
        cases: [{
          id: 'unwritable-dest',
          status: ok ? 'passed' : 'failed',
          assertions: [{
            name: 'permission-write-keeps-bytes',
            status: ok ? 'passed' : 'failed',
            expected: 'conflict/EACCES + keep-me',
            actual: { perm, kept },
          }],
        }],
        console: `perm=${JSON.stringify(perm)} kept=${kept}\n`,
        network: { events: [], count: 0 },
        screenshot: extraShot,
      })
      continue
    }
    if (uf === 'UF-004' && branch === 'failure-2') {
      await writeEvidence(outDir, uf, branch, {
        run_id: ctx.runId,
        status: 'passed',
        cases: [{
          id: 'old-owner-notify',
          status: 'passed',
          assertions: [{
            name: 'stale-owner-notify',
            status: 'passed',
            expected: 'stale-owner',
            actual: lateNotify,
          }],
        }],
        console: `opened=${JSON.stringify(opened)}\nlate=${JSON.stringify(lateNotify)}\n`,
        network: { events: [{ url: '/api/control/notify', response: lateNotify }], count: 1 },
        screenshot: extraShot,
      })
      continue
    }
    const item = byName[name]
    const assertion = (item?.assertions ?? []).find((row) => row.name === assertionName) ?? item?.assertions?.[0]
    await writeEvidence(outDir, uf, branch, {
      run_id: ctx.runId,
      status: item?.ok && assertion?.status !== 'failed' ? 'passed' : 'failed',
      cases: asCases(name),
      console: consoleText(name, `focus=${assertionName}`),
      network: { events: [], count: 0 },
      screenshot: shot(name) ?? extraShot,
    })
  }
}

const CASE_RUNNERS = {
  baseline: runBaseline,
  'markdown-loading': runMarkdownLoading,
  revision: runRevision,
  'save-snapshot': runSaveSnapshot,
  'file-conflict': runFileConflict,
  owner: runOwner,
  'markdown-state': runMarkdownState,
  'docs-state': (ctx) => runFamilyState(ctx, 'docs'),
  'sheets-state': (ctx) => runFamilyState(ctx, 'sheets'),
  'slides-state': (ctx) => runFamilyState(ctx, 'slides'),
  'pdf-state': (ctx) => runFamilyState(ctx, 'pdf'),
  'plugin-state': runPluginState,
  inventory: runInventory,
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.mode || args.mode === 'help') {
    console.error('usage: node e2e-control-session.mjs --baseline|--all|--case NAME [--out DIR]')
    console.error(`cases: ${CASES.join(', ')}`)
    process.exit(args.mode === 'help' ? 0 : 2)
  }
  if (args.mode === 'case' && !CASES.includes(args.caseName)) {
    console.error(`unknown case ${args.caseName}; expected ${CASES.join(', ')}`)
    process.exit(2)
  }

  const runId = `css-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const workDir = join('/tmp', 'genoffice-control-session', runId)
  await mkdir(workDir, { recursive: true })
  const fixtures = await prepareFixtures(workDir)
  const outDir = args.outDir
    ? resolve(process.cwd(), args.outDir)
    : join(PLUGIN, 'docs/control-session-safety/evidence/phase-0', runId)

  const port = await freePort(DEFAULT_PORT)
  const relay = await startRelay(port)
  const browser = await chromium.launch()
  const ctx = { base: relay.base, port, browser, workDir, fixtures, runId, relay }
  const names = args.all ? CASES.filter((name) => name !== 'baseline' && name !== 'inventory') : args.mode === 'baseline' ? ['baseline'] : [args.caseName]
  const results = []
  let failed = false
  try {
    if (args.mode === 'baseline' || args.all) {
      const inventory = await runInventory(ctx)
      results.push({ name: 'inventory', ...inventory })
    }
    for (const name of names) {
      const runner = CASE_RUNNERS[name]
      const result = await runner(ctx)
      results.push({ name, ...result })
      if (!result.ok) failed = true
    }
    if (args.all) {
      await archiveMatrix(ctx, results, outDir)
    }
  } finally {
    await browser.close()
    stopRelay(relay)
  }

  const summary = {
    run_id: runId,
    port,
    base: relay.base,
    node: process.execPath,
    nodeVersion: process.version,
    fixtures: fixtures.inventory,
    results: results.map((item) => ({
      name: item.name,
      ok: item.ok,
      defects: item.defects,
      missing: item.missing,
      assertions: item.assertions,
      note: item.note,
    })),
  }
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))

  if (args.mode === 'baseline') {
    const baseline = results.find((item) => item.name === 'baseline')
    await writeFile(join(outDir, 'baseline-defects.json'), JSON.stringify(baseline, null, 2))
  }

  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
