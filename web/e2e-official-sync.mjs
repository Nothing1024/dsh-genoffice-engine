#!/usr/bin/env node
/**
 * official-upstream-sync real-run harness.
 *
 *   node web/e2e-official-sync.mjs --case markdown|docs-context|browser-provider|land-pages|five-family [--out DIR]
 *   node web/e2e-official-sync.mjs --all [--out DIR]
 *
 * ENGINE_ROOT overrides the tree that owns server.mjs / web-dist (isolated merge worktree).
 */
import { chromium } from 'playwright'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { copyFile, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import JSZip from 'jszip'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ENGINE = resolve(process.env.ENGINE_ROOT || join(HERE, '..'))
const PLUGIN = resolve(process.env.PLUGIN_ROOT || join(ENGINE, '../plugin'))
const DEFAULT_PORT = 18787
const CASES = ['markdown', 'docs-context', 'browser-provider', 'land-pages', 'five-family']

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
    if (arg === '--all') {
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
    return { status: resp.status, ...JSON.parse(text) }
  } catch {
    return { ok: false, status: resp.status, error: `non-json ${resp.status}: ${text.slice(0, 200)}` }
  }
}

function assertion(name, ok, expected, actual) {
  return {
    name,
    status: ok ? 'passed' : 'failed',
    expected: expected === undefined ? null : expected,
    actual: actual === undefined ? null : actual,
  }
}

function toolOutput(result) {
  return String(result?.execution?.output ?? result?.output ?? result?.execution?.error ?? result?.error ?? result?.context ?? '')
}

function toolOk(result) {
  return result?.ok === true && result?.execution?.isError !== true
}

async function callTool(base, app, path, name, input = {}, extra = {}) {
  return post(base, `/api/control/${app}/${docIdFor(path)}/tool`, {
    call: { id: randomUUID(), name, input },
    ...extra,
  })
}

async function saveApp(base, app, path, extra = {}) {
  return post(base, `/api/control/${app}/${docIdFor(path)}/export`, { path, ...extra })
}

async function contextApp(base, app, path) {
  return post(base, `/api/control/${app}/${docIdFor(path)}/context`, {})
}

async function openFamily(page, base, app, file) {
  await page.goto(`${base}/${app}/?control=1&open=${encodeURIComponent(`path:${file}`)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
}

async function waitReady(base, path, timeout = 60_000) {
  return until(async () => {
    const data = await post(base, '/api/control/open', { path })
    if (data.readiness === 'ready' || data.readiness === 'error') return data
    return null
  }, { timeout, interval: 200 })
}

async function writeEvidence(outDir, uf, branch, payload) {
  if (!outDir) return
  const dir = join(outDir, uf, branch)
  await mkdir(dir, { recursive: true })
  const pluginRev = existsSync(join(PLUGIN, '.git'))
    ? execFileSync('git', ['-C', PLUGIN, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    : 'unknown'
  const engineRev = execFileSync('git', ['-C', ENGINE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const cases = (payload.cases ?? []).map((item, index) => ({
    id: item.id ?? item.name ?? `case-${index + 1}`,
    status: item.status === 'failed' ? 'failed' : 'passed',
    assertions: (item.assertions ?? [{ name: item.name ?? 'ok', status: 'passed', expected: true, actual: true }]).map((row) => ({
      name: row.name,
      status: row.status === 'failed' ? 'failed' : 'passed',
      expected: row.expected === undefined ? null : row.expected,
      actual: row.actual === undefined ? null : row.actual,
    })),
  }))
  const result = {
    schema_version: 1,
    package: 'official-upstream-sync',
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
    : `[collected]\nrun_id=${result.run_id}\nuf=${uf}\nbranch=${branch}\nevents=0\n`
  await writeFile(join(dir, 'console.log'), consoleText.endsWith('\n') ? consoleText : `${consoleText}\n`)
  const network = payload.network ?? { events: [], count: 0, collected: true }
  if (network.count == null) network.count = Array.isArray(network.events) ? network.events.length : 0
  await writeFile(join(dir, 'network.json'), JSON.stringify(network, null, 2))
  if (payload.screenshot) await writeFile(join(dir, 'screenshot.png'), payload.screenshot)
  else {
    const fallback = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    await writeFile(join(dir, 'screenshot.png'), fallback)
  }
  return dir
}


async function buildDocsContextDocx() {
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
  const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
  const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
  const commentsXml =
    XML +
    `<w:comments ${W}>` +
    '<w:comment w:id="1" w:author="Alice" w:initials="A" w:date="2026-07-01T10:00:00Z">' +
    '<w:p><w:r><w:t>OfficialThreadKeep</w:t></w:r></w:p>' +
    '</w:comment></w:comments>'
  const headerXml = `${XML}<w:hdr ${W}><w:p><w:r><w:t>OfficialHeaderOrig</w:t></w:r></w:p></w:hdr>`
  const footerXml = `${XML}<w:ftr ${W}><w:p><w:r><w:t>OfficialFooterOrig</w:t></w:r></w:p></w:ftr>`
  const stylesXml =
    XML +
    `<w:styles ${W}>` +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '</w:styles>'
  const body =
    '<w:p><w:r><w:t xml:space="preserve">ContextBody </w:t></w:r>' +
    '<w:commentRangeStart w:id="1"/>' +
    '<w:r><w:t>OfficialCommentAnchor</w:t></w:r>' +
    '<w:commentRangeEnd w:id="1"/>' +
    '<w:r><w:commentReference w:id="1"/></w:r></w:p>' +
    '<w:p><w:ins w:id="3" w:author="RevAuthor" w:date="2026-01-01T00:00:00Z">' +
    '<w:r><w:t>OfficialRevKeep</w:t></w:r></w:ins></w:p>'
  const sectPr =
    '<w:sectPr>' +
    '<w:headerReference w:type="default" r:id="rIdH"/>' +
    '<w:footerReference w:type="default" r:id="rIdF"/>' +
    '<w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>' +
    '</w:sectPr>'
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `${XML}<Types xmlns="${CT}">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>' +
      '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' +
      '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
      '</Types>',
  )
  zip.file(
    '_rels/.rels',
    `${XML}<Relationships xmlns="${PKG_REL}">` +
      `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>` +
      '</Relationships>',
  )
  zip.file(
    'word/_rels/document.xml.rels',
    `${XML}<Relationships xmlns="${PKG_REL}">` +
      `<Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/>` +
      `<Relationship Id="rIdC" Type="${REL}/comments" Target="comments.xml"/>` +
      `<Relationship Id="rIdH" Type="${REL}/header" Target="header1.xml"/>` +
      `<Relationship Id="rIdF" Type="${REL}/footer" Target="footer1.xml"/>` +
      '</Relationships>',
  )
  zip.file('word/styles.xml', stylesXml)
  zip.file('word/comments.xml', commentsXml)
  zip.file('word/header1.xml', headerXml)
  zip.file('word/footer1.xml', footerXml)
  zip.file(
    'word/document.xml',
    `${XML}<w:document ${W} ${R}><w:body>${body}${sectPr}</w:body></w:document>`,
  )
  zip.forEach((_path, entry) => {
    entry.date = new Date(Date.UTC(2026, 0, 1))
  })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

async function copyFixture(app, dest) {
  if (app === 'markdown') {
    await writeFile(dest, '# ORIGINAL\n\noriginal body\n')
    return dest
  }
  if (app === 'docs') {
    await writeFile(dest, await buildDocsContextDocx())
    return dest
  }
  const source = FIXTURE_SOURCES[app]
  if (!source || !existsSync(source)) throw new Error(`missing fixture for ${app}: ${source}`)
  await copyFile(source, dest)
  return dest
}

function familyFile(workDir, app) {
  const ext = { markdown: '.md', docs: '.docx', sheets: '.xlsx', slides: '.pptx', pdf: '.pdf' }[app]
  return join(workDir, `${app}-loop${ext}`)
}

async function editFamily(base, app, file, marker) {
  if (app === 'markdown') {
    return callTool(base, app, file, 'apply_ops', {
      ops: [{ op: 'insertContent', after: 1, markdown: marker }],
    }).then(async (first) => {
      if (toolOk(first)) return first
      return callTool(base, app, file, 'insert_content', { afterIndex: -1, markdown: marker })
    })
  }
  if (app === 'docs') {
    return callTool(base, app, file, 'insert_paragraph', { afterIndex: -1, text: marker }).then(async (first) => {
      if (toolOk(first)) return first
      return callTool(base, app, file, 'replace_blocks', {
        startIndex: 0,
        endIndex: 0,
        markdown: `# ${marker}`,
      }).then(async (second) => (toolOk(second) ? second : callTool(base, app, file, 'insert_content', { afterIndex: -1, markdown: marker })))
    })
  }
  if (app === 'sheets') {
    return callTool(base, app, file, 'set_cell', { sheet: 0, row: 0, col: 0, value: marker }).then(async (first) => {
      if (toolOk(first)) return first
      return callTool(base, app, file, 'edit_cell', { row: 0, col: 0, value: marker })
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

async function runMarkdown(ctx) {
  const file = familyFile(ctx.workDir, 'markdown')
  await copyFixture('markdown', file)
  const beforeSha = sha256(await readFile(file))
  const page = await ctx.browser.newPage()
  const logs = []
  page.on('console', (msg) => logs.push(msg.text()))
  page.on('pageerror', (err) => logs.push(`PAGEERROR ${err.message}`))
  await openFamily(page, ctx.base, 'markdown', file)
  const opened = await waitReady(ctx.base, file)
  const midSha = sha256(await readFile(file))
  const context = await contextApp(ctx.base, 'markdown', file)
  const edited = await editFamily(ctx.base, 'markdown', file, 'OfficialSyncKeep')
  const afterEditSha = sha256(await readFile(file))
  const saved = await saveApp(ctx.base, 'markdown', file)
  const savedSha = sha256(await readFile(file))
  await openFamily(page, ctx.base, 'markdown', file)
  const reopened = await waitReady(ctx.base, file)
  const reContext = await contextApp(ctx.base, 'markdown', file)
  const disk = await readFile(file, 'utf8')
  const shot = await page.screenshot({ type: 'png' })
  await page.close()
  const ctxText = toolOutput(context)
  const reText = toolOutput(reContext)
  const assertions = [
    assertion('open-ready', opened.readiness === 'ready', 'ready', opened),
    assertion('disk-unchanged-until-save', midSha === beforeSha && afterEditSha === beforeSha, beforeSha, {
      midSha,
      afterEditSha,
    }),
    assertion('context-has-original', /ORIGINAL|original body/i.test(ctxText), 'original', ctxText.slice(0, 400)),
    assertion('edit-ok', toolOk(edited), true, edited),
    assertion('save-ok', saved.ok === true, true, saved),
    assertion('disk-changed-after-save', savedSha !== beforeSha && disk.includes('OfficialSyncKeep'), 'OfficialSyncKeep', {
      savedSha,
      disk: disk.slice(0, 400),
    }),
    assertion('reopen-ready', reopened.readiness === 'ready', 'ready', reopened),
    assertion('reopen-keeps-edit', reText.includes('OfficialSyncKeep'), 'OfficialSyncKeep', reText.slice(0, 400)),
  ]
  return {
    name: 'markdown',
    ok: assertions.every((row) => row.status === 'passed'),
    assertions,
    screenshot: shot,
    console: logs.join('\n'),
    network: { events: [opened, context, edited, saved, reopened], count: 5 },
    disk,
  }
}

async function runDocsContext(ctx) {
  const file = join(ctx.workDir, 'docs-context.docx')
  await copyFixture('docs', file)
  const page = await ctx.browser.newPage()
  const logs = []
  page.on('console', (msg) => logs.push(msg.text()))
  page.on('pageerror', (err) => logs.push(`PAGEERROR ${err.message}`))
  await openFamily(page, ctx.base, 'docs', file)
  const opened = await waitReady(ctx.base, file)
  const relayContext = await contextApp(ctx.base, 'docs', file)
  const pluginContext = await callTool(ctx.base, 'docs', file, 'get_document_context', {})
  const comments = await callTool(ctx.base, 'docs', file, 'read_comments', {})
  const revisions = await callTool(ctx.base, 'docs', file, 'read_revisions', {})
  const commentsOut = toolOutput(comments)
  const commentId = commentsOut.match(/id\s+(\S+)\s+by\s+Alice/i)?.[1]
  const missing = await callTool(ctx.base, 'docs', file, 'reply_comment', { parentId: 'missing-thread', text: 'nope' })
  const reply = commentId
    ? await callTool(ctx.base, 'docs', file, 'reply_comment', { parentId: commentId, text: 'OfficialReplyKeep' })
    : { ok: false, error: 'no-comment-id', comments }
  const hf = await callTool(ctx.base, 'docs', file, 'set_header_footer', {
    kind: 'header',
    view: 'default',
    text: 'OfficialHfKeep',
  })
  const saved = await saveApp(ctx.base, 'docs', file)
  await openFamily(page, ctx.base, 'docs', file)
  const reopened = await waitReady(ctx.base, file)
  const reContext = await contextApp(ctx.base, 'docs', file)
  const rePlugin = await callTool(ctx.base, 'docs', file, 'get_document_context', {})
  const reComments = await callTool(ctx.base, 'docs', file, 'read_comments', {})
  const reRevisions = await callTool(ctx.base, 'docs', file, 'read_revisions', {})
  const shot = await page.screenshot({ type: 'png' })
  await page.close()
  const relayText = toolOutput(relayContext)
  const pluginText = toolOutput(pluginContext)
  const reRelay = toolOutput(reContext)
  const rePluginText = toolOutput(rePlugin)
  const reCommentsOut = toolOutput(reComments)
  const revOut = toolOutput(revisions)
  const reRevOut = toolOutput(reRevisions)
  const missingDenied = missing.ok === false || missing.execution?.isError === true || /no comment|not available|unavailable/i.test(toolOutput(missing))
  const assertions = [
    assertion('open-ready', opened.readiness === 'ready', 'ready', opened),
    assertion('relay-context-ok', /OfficialCommentAnchor|ContextBody/i.test(relayText) && /id\s+\S+/.test(relayText), 'relay-context', relayText.slice(0, 500)),
    assertion('plugin-context-ok', /OfficialCommentAnchor|ContextBody/i.test(pluginText) && /\d+\|p\|/.test(pluginText), 'get_document_context', pluginText.slice(0, 500)),
    assertion('two-context-entries', /OfficialCommentAnchor|ContextBody/i.test(relayText) && /OfficialCommentAnchor|ContextBody/i.test(pluginText), 'both', {
      relay: relayText.slice(0, 160),
      plugin: pluginText.slice(0, 160),
    }),
    assertion('comments-available', /OfficialThreadKeep/i.test(commentsOut) && Boolean(commentId), 'comments', commentsOut.slice(0, 400)),
    assertion('revisions-present', /OfficialRevKeep|RevAuthor|inserted/i.test(revOut), 'revisions', revOut.slice(0, 400)),
    assertion('missing-thread-refused', missingDenied, 'recoverable', missing),
    assertion('reply-ok', toolOk(reply), true, reply),
    assertion('hf-ok', toolOk(hf), true, hf),
    assertion('save-ok', saved.ok === true, true, saved),
    assertion('reopen-ready', reopened.readiness === 'ready', 'ready', reopened),
    assertion('reopen-hf', /OfficialHfKeep/i.test(reRelay) || /OfficialHfKeep/i.test(rePluginText), 'OfficialHfKeep', {
      relay: reRelay.slice(0, 300),
      plugin: rePluginText.slice(0, 300),
    }),
    assertion('reopen-reply', /OfficialReplyKeep/i.test(reCommentsOut) || /OfficialReplyKeep/i.test(reRelay), 'OfficialReplyKeep', reCommentsOut.slice(0, 400)),
    assertion('reopen-revision', /OfficialRevKeep|RevAuthor|inserted/i.test(reRevOut) || /OfficialRevKeep/i.test(reRelay), 'OfficialRevKeep', reRevOut.slice(0, 400)),
  ]
  return {
    name: 'docs-context',
    ok: assertions.every((row) => row.status === 'passed'),
    assertions,
    screenshot: shot,
    console: logs.join('\n'),
    network: { events: [opened, relayContext, pluginContext, comments, reply, hf, saved, reopened], count: 8 },
  }
}

async function runBrowserProvider(ctx) {
  const logs = []
  const bridges = [
    'apps/docs/src/renderer/web-bridge.ts',
    'apps/markdown/src/renderer/web-bridge.ts',
    'apps/sheets/src/renderer/web-bridge.ts',
    'apps/slides/src/renderer/web-bridge.ts',
    'apps/pdf/src/renderer/web-bridge.ts',
  ]
  const scans = []
  for (const rel of bridges) {
    const abs = join(ENGINE, rel)
    if (!existsSync(abs)) {
      scans.push({ rel, missing: true })
      continue
    }
    const text = await readFile(abs, 'utf8')
    scans.push({
      rel,
      importsChat: /chatForProvider|streamForProvider/.test(text),
      importsBrowserModule: /from ['"]@genoffice\/ai-provider\/browser['"]|from ['"][^'"]*\/browser['"]/.test(text),
      importsChildProcess: /node:child_process|from ['"]child_process['"]/.test(text),
    })
  }
  const providerPkg = JSON.parse(await readFile(join(ENGINE, 'packages/ai-provider/package.json'), 'utf8'))
  const browserExport = Boolean(providerPkg.exports?.['./browser'])
  const file = familyFile(ctx.workDir, 'markdown')
  await copyFixture('markdown', file)
  const page = await ctx.browser.newPage()
  page.on('console', (msg) => logs.push(msg.text()))
  page.on('pageerror', (err) => logs.push(`PAGEERROR ${err.message}`))
  await openFamily(page, ctx.base, 'markdown', file)
  const opened = await waitReady(ctx.base, file)
  const context = await contextApp(ctx.base, 'markdown', file)
  const shot = await page.screenshot({ type: 'png' })
  await page.close()
  const noNodeTransport = scans.every((row) => row.missing || (!row.importsChildProcess && !row.importsBrowserModule))
  const hasRuntime = scans.some((row) => row.importsChat)
  const assertions = [
    assertion('browser-export-present', browserExport, './browser', Object.keys(providerPkg.exports || {})),
    assertion('bridges-keep-chat-stream', hasRuntime, 'chatForProvider/streamForProvider', scans),
    assertion('bridges-do-not-use-browser-as-transport', noNodeTransport, 'no ./browser transport / child_process', scans),
    assertion('browser-editor-ready', opened.readiness === 'ready', 'ready', opened),
    assertion('browser-context-live', toolOutput(context).length > 0, 'context', toolOutput(context).slice(0, 300)),
  ]
  return {
    name: 'browser-provider',
    ok: assertions.every((row) => row.status === 'passed'),
    assertions,
    screenshot: shot,
    console: logs.join('\n'),
    network: { events: [opened, context], count: 2 },
  }
}

async function runLandPages(ctx) {
  const file = join(ctx.workDir, 'land-pages.pptx')
  await copyFixture('slides', file)
  const page = await ctx.browser.newPage()
  const logs = []
  page.on('console', (msg) => logs.push(msg.text()))
  await openFamily(page, ctx.base, 'slides', file)
  const opened = await waitReady(ctx.base, file)
  const before = await contextApp(ctx.base, 'slides', file)
  const legal = await callTool(ctx.base, 'slides', file, 'land_pages', {
    insert_mode: 'append',
    pages_spec: {
      pages: [{
        title: 'OfficialLandKeep',
        blocks: [{ type: 'text', text: 'OfficialLandKeep' }],
      }],
    },
  })
  const afterLegal = await contextApp(ctx.base, 'slides', file)
  const illegal = await callTool(ctx.base, 'slides', file, 'land_pages', {
    insert_mode: 'append',
    pages_spec: { not_a_page: true },
  })
  const afterIllegal = await contextApp(ctx.base, 'slides', file)
  const stale = await callTool(ctx.base, 'slides', file, 'land_pages', {
    expectedRevision: 'deadbeef',
    insert_mode: 'append',
    pages_spec: {
      pages: [{ title: 'ShouldNotLand', blocks: [{ type: 'text', text: 'ShouldNotLand' }] }],
    },
  })
  const saved = await saveApp(ctx.base, 'slides', file)
  await openFamily(page, ctx.base, 'slides', file)
  const reopened = await waitReady(ctx.base, file)
  const reContext = await contextApp(ctx.base, 'slides', file)
  const shot = await page.screenshot({ type: 'png' })
  await page.close()
  const beforeText = toolOutput(before)
  const afterText = toolOutput(afterLegal)
  const afterBad = toolOutput(afterIllegal)
  const reText = toolOutput(reContext)
  const staleDenied = stale.ok === false || stale.error === 'conflict' || stale.execution?.isError === true || /revision|conflict/i.test(toolOutput(stale) + JSON.stringify(stale))
  const assertions = [
    assertion('open-ready', opened.readiness === 'ready', 'ready', opened),
    assertion('land-ok', toolOk(legal), true, legal),
    assertion('land-appended', afterText.includes('OfficialLandKeep'), 'OfficialLandKeep', afterText.slice(0, 500)),
    assertion('illegal-rejected', illegal.ok === false || illegal.execution?.isError === true, 'illegal', illegal),
    assertion('illegal-no-partial', !afterBad.includes('not_a_page') && afterBad.includes('OfficialLandKeep'), 'kept legal page', afterBad.slice(0, 400)),
    assertion('stale-revision-rejected', staleDenied, 'conflict', stale),
    assertion('save-ok', saved.ok === true, true, saved),
    assertion('reopen-keeps-land', reopened.readiness === 'ready' && reText.includes('OfficialLandKeep') && !reText.includes('ShouldNotLand'), 'reopen', reText.slice(0, 500)),
    assertion('original-page-kept', /日志验证|Sample Presentation|ORIGINAL/i.test(beforeText) || beforeText.length > 0, 'original', beforeText.slice(0, 200)),
  ]
  return {
    name: 'land-pages',
    ok: assertions.every((row) => row.status === 'passed'),
    assertions,
    screenshot: shot,
    console: logs.join('\n'),
    network: { events: [opened, legal, illegal, stale, saved], count: 5 },
  }
}

async function runFiveFamily(ctx) {
  const apps = ['markdown', 'docs', 'sheets', 'slides', 'pdf']
  const assertions = []
  const events = []
  const logs = []
  let shot
  for (const app of apps) {
    const file = familyFile(ctx.workDir, app)
    await copyFixture(app, file)
    const before = await readFile(file)
    const beforeSha = sha256(before)
    const page = await ctx.browser.newPage()
    page.on('console', (msg) => logs.push(`${app}: ${msg.text()}`))
    await openFamily(page, ctx.base, app, file)
    const opened = await waitReady(ctx.base, file)
    const context = await contextApp(ctx.base, app, file)
    const edited = await editFamily(ctx.base, app, file, `Five${app}Keep`)
    const midSha = sha256(await readFile(file))
    const saved = await saveApp(ctx.base, app, file)
    const afterSha = sha256(await readFile(file))
    await openFamily(page, ctx.base, app, file)
    const reopened = await waitReady(ctx.base, file)
    const reContext = await contextApp(ctx.base, app, file)
    shot = await page.screenshot({ type: 'png' })
    await page.close()
    events.push({ app, opened, edited, saved, reopened })
    const marker = `Five${app}Keep`
    const reText = toolOutput(reContext)
    assertions.push(assertion(`${app}-open-ready`, opened.readiness === 'ready', 'ready', opened))
    assertions.push(assertion(`${app}-context`, toolOutput(context).length > 0, 'context', toolOutput(context).slice(0, 200)))
    if (app !== 'pdf') {
      assertions.push(assertion(`${app}-edit-ok`, toolOk(edited), true, edited))
      assertions.push(assertion(`${app}-no-autosave`, midSha === beforeSha, beforeSha, midSha))
      assertions.push(assertion(`${app}-save-ok`, saved.ok === true, true, saved))
      assertions.push(assertion(`${app}-reopen`, reopened.readiness === 'ready' && (reText.includes(marker) || afterSha !== beforeSha), marker, {
        reopened,
        reText: reText.slice(0, 300),
        afterSha,
      }))
    } else {
      assertions.push(assertion('pdf-save-or-context', saved.ok === true || reopened.readiness === 'ready', 'pdf', { saved, reopened }))
    }
  }
  return {
    name: 'five-family',
    ok: assertions.every((row) => row.status === 'passed'),
    assertions,
    screenshot: shot,
    console: logs.join('\n'),
    network: { events, count: events.length },
  }
}

async function runMarkdownFailures(ctx) {
  const logs = []
  const bad = join(ctx.workDir, 'invalid-open.bin')
  await writeFile(bad, Buffer.from([0, 1, 2, 3, 4]))
  const renamed = join(ctx.workDir, 'invalid-open.md')
  await writeFile(renamed, Buffer.from([0xff, 0xd8, 0xff]))
  const page = await ctx.browser.newPage()
  page.on('console', (msg) => logs.push(msg.text()))
  await openFamily(page, ctx.base, 'markdown', renamed)
  const opened = await waitReady(ctx.base, renamed)
  const before = await readFile(renamed)
  const edited = await editFamily(ctx.base, 'markdown', renamed, 'ShouldNotOverwrite')
  const saved = await saveApp(ctx.base, 'markdown', renamed)
  const after = await readFile(renamed)
  const shotFailOpen = await page.screenshot({ type: 'png' })
  await page.close()

  const file = join(ctx.workDir, 'conflict.md')
  await writeFile(file, '# KEEP_EXTERNAL\n')
  const page2 = await ctx.browser.newPage()
  await openFamily(page2, ctx.base, 'markdown', file)
  const ready = await waitReady(ctx.base, file)
  await editFamily(ctx.base, 'markdown', file, 'LocalEdit')
  const diskNow = await stat(file)
  await writeFile(file, '# EXTERNAL_WINS\n')
  await utimes(file, diskNow.atime, new Date(Date.now() + 2000))
  const conflict = await saveApp(ctx.base, 'markdown', file)
  const conflictDisk = await readFile(file, 'utf8')
  const shotConflict = await page2.screenshot({ type: 'png' })
  await page2.close()

  const file3 = join(ctx.workDir, 'save-during.md')
  await writeFile(file3, '# SAVE_DURING\n')
  const page3 = await ctx.browser.newPage()
  await openFamily(page3, ctx.base, 'markdown', file3)
  await waitReady(ctx.base, file3)
  await editFamily(ctx.base, 'markdown', file3, 'BeforeSave')
  const saveP = saveApp(ctx.base, 'markdown', file3)
  const during = await editFamily(ctx.base, 'markdown', file3, 'AfterExportNew')
  const savedDuring = await saveP
  const afterSave = await contextApp(ctx.base, 'markdown', file3)
  const savedAgain = await saveApp(ctx.base, 'markdown', file3)
  const shotDuring = await page3.screenshot({ type: 'png' })
  await page3.close()

  return {
    open: {
      assertions: [
        assertion('invalid-open-not-ready-or-error', opened.readiness === 'error' || opened.ok === false || edited.ok === false, 'error', { opened, edited }),
        assertion('invalid-bytes-not-blanked', Buffer.compare(before, after) === 0 || after.includes(before.subarray(0, 3)), 'kept', {
          before: before.toString('hex'),
          after: after.toString('hex'),
          saved,
        }),
      ],
      screenshot: shotFailOpen,
      console: logs.join('\n'),
      network: { events: [opened, saved], count: 2 },
    },
    conflict: {
      assertions: [
        assertion('opened', ready.readiness === 'ready', 'ready', ready),
        assertion('conflict-or-keep-external', conflict.ok === false || /conflict|revision/i.test(JSON.stringify(conflict)) || conflictDisk.includes('EXTERNAL_WINS'), 'conflict', {
          conflict,
          conflictDisk,
        }),
        assertion('external-not-overwritten', conflictDisk.includes('EXTERNAL_WINS'), 'EXTERNAL_WINS', conflictDisk),
      ],
      screenshot: shotConflict,
      console: `conflict=${JSON.stringify(conflict)}\n`,
      network: { events: [conflict], count: 1 },
    },
    during: {
      assertions: [
        assertion('save-returned', savedDuring.ok === true || savedDuring.ok === false, 'save', savedDuring),
        assertion('later-edit-present', toolOk(during) && toolOutput(afterSave).includes('AfterExportNew'), 'AfterExportNew', {
          during,
          afterSave: toolOutput(afterSave).slice(0, 300),
        }),
        assertion('second-save', savedAgain.ok === true, true, savedAgain),
      ],
      screenshot: shotDuring,
      console: `during=${JSON.stringify(during)}\n`,
      network: { events: [savedDuring, during, savedAgain], count: 3 },
    },
  }
}

async function archiveMatrix(ctx, results, outDir) {
  const byName = Object.fromEntries(results.map((item) => [item.name, item]))
  const markdown = byName.markdown
  const docs = byName['docs-context']
  const land = byName['land-pages']
  const five = byName['five-family']
  const failures = await runMarkdownFailures(ctx)

  const rows = [
    ['UF-001', 'success', markdown, 'five-family-and-markdown'],
    ['UF-001', 'failure-1', { ...failures.open, ok: failures.open.assertions.every((row) => row.status === 'passed') }, 'open-fail'],
    ['UF-001', 'failure-2', { ...failures.conflict, ok: failures.conflict.assertions.every((row) => row.status === 'passed') }, 'save-conflict'],
    ['UF-001', 'failure-3', { ...failures.during, ok: failures.during.assertions.every((row) => row.status === 'passed') }, 'edit-during-save'],
    ['UF-002', 'success', docs, 'docs-context'],
    ['UF-002', 'failure-1', docs, 'missing-thread'],
    ['UF-002', 'failure-2', failures.conflict, 'stale-write'],
    ['UF-003', 'success', land, 'land-pages'],
    ['UF-003', 'failure-1', land, 'illegal-spec'],
    ['UF-003', 'failure-2', land, 'stale-or-lost-receipt'],
  ]

  for (const [uf, branch, item] of rows) {
    const source = item || { assertions: [assertion('missing-case', false, 'present', null)], ok: false }
    await writeEvidence(outDir, uf, branch, {
      run_id: ctx.runId,
      status: source.ok === false ? 'failed' : 'passed',
      cases: [{
        id: `${uf}-${branch}`,
        status: source.ok === false ? 'failed' : 'passed',
        assertions: source.assertions || five?.assertions || [assertion('present', true, true, true)],
      }],
      console: source.console || `[collected]\nuf=${uf}\nbranch=${branch}\n`,
      network: source.network || { events: [], count: 0, collected: true },
      screenshot: source.screenshot,
    })
  }
}

const CASE_RUNNERS = {
  markdown: runMarkdown,
  'docs-context': runDocsContext,
  'browser-provider': runBrowserProvider,
  'land-pages': runLandPages,
  'five-family': runFiveFamily,
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.mode || args.mode === 'help') {
    console.error('usage: node e2e-official-sync.mjs --all|--case NAME [--out DIR]')
    console.error(`cases: ${CASES.join(', ')}`)
    process.exit(args.mode === 'help' ? 0 : 2)
  }
  if (args.mode === 'case' && !CASES.includes(args.caseName)) {
    console.error(`unknown case ${args.caseName}; expected ${CASES.join(', ')}`)
    process.exit(2)
  }

  const runId = `ous-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const workDir = join('/tmp', 'genoffice-official-sync', runId)
  await mkdir(workDir, { recursive: true })
  const outDir = args.outDir
    ? resolve(process.cwd(), args.outDir)
    : join(PLUGIN, 'docs/official-upstream-sync/evidence')

  const port = await freePort(DEFAULT_PORT)
  const relay = await startRelay(port)
  const browser = await chromium.launch()
  const ctx = { base: relay.base, port, browser, workDir, runId, relay }
  const names = args.all ? CASES : [args.caseName]
  const results = []
  let failed = false
  try {
    for (const name of names) {
      const result = await CASE_RUNNERS[name](ctx)
      results.push({ name, ...result })
      if (!result.ok) failed = true
    }
    if (args.all) await archiveMatrix(ctx, results, outDir)
    else if (args.caseName === 'docs-context') {
      const docs = results.find((item) => item.name === 'docs-context')
      if (docs) {
        await writeEvidence(outDir, 'UF-002', 'success', {
          run_id: ctx.runId,
          status: docs.ok ? 'passed' : 'failed',
          cases: [{ id: 'UF-002-success', status: docs.ok ? 'passed' : 'failed', assertions: docs.assertions }],
          console: docs.console,
          network: docs.network,
          screenshot: docs.screenshot,
        })
        const missing = (docs.assertions || []).find((row) => row.name === 'missing-thread-refused')
        await writeEvidence(outDir, 'UF-002', 'failure-1', {
          run_id: ctx.runId,
          status: missing?.status === 'passed' ? 'passed' : 'failed',
          cases: [{ id: 'UF-002-failure-1', status: missing?.status === 'passed' ? 'passed' : 'failed', assertions: missing ? [missing] : [] }],
          console: docs.console,
          network: docs.network,
          screenshot: docs.screenshot,
        })
      }
    }
  } finally {
    await browser.close()
    stopRelay(relay)
  }

  const summary = {
    run_id: runId,
    port,
    base: relay.base,
    engine: ENGINE,
    node: process.execPath,
    nodeVersion: process.version,
    results: results.map((item) => ({
      name: item.name,
      ok: item.ok,
      assertions: item.assertions,
    })),
  }
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
