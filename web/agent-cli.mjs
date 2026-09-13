#!/usr/bin/env node
/**
 * GenOffice control CLI — same HTTP+SSE contract as the plugin, no second editor.
 *
 *   node web/agent-cli.mjs --help
 *   node web/agent-cli.mjs open --path FILE
 *   node web/agent-cli.mjs context --path FILE
 *   node web/agent-cli.mjs edit --path FILE --marker TEXT
 *   node web/agent-cli.mjs save --path FILE
 *   node web/agent-cli.mjs reopen --path FILE
 */
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { APP_BY_EXT, GenOfficeClient, appForPath, toolOk, toolOutput } from './sdk/genoffice-control.mjs'
import { HeadlessExecutor } from './sdk/headless-executor.mjs'

const HELP = `genoffice-agent — reuse the GenOffice control protocol (HTTP+SSE)

Usage:
  node web/agent-cli.mjs <command> --path <abs-or-rel-file> [options]

Commands:
  open      POST /api/control/open and wait until readiness=ready
  context   POST /api/control/<app>/<docId>/context
  edit      family-specific in-iframe edit (markdown insert_content)
  save      POST /api/control/<app>/<docId>/export (explicit disk write)
  reopen    open + context after a previous save
  run       headless open→edit→save→reopen in one process
  discover  GET /api/discovery

Options:
  --path PATH              target file (required except discover)
  --base URL               relay base (default http://127.0.0.1:8787 or $GENOFFICE_RELAY)
  --family FAMILY          xlsx|pptx|md|... ; sent as X-GenOffice-Family
  --schema-revision REV    default 2026.09.1
  --marker TEXT            markdown insert marker for edit (default WreCliKeep)
  --timeout MS             waitReady timeout (default 90000)
  --headless               spawn a Playwright renderer if no executor is registered
  --help                   print this help

Exit codes:
  0  ok
  1  usage / local argument error
  2  relay/protocol error (executor missing, conflict, 409, abort)
  3  cancelled / aborted
`

function parseArgs(argv) {
  const out = { command: null, path: null, base: process.env.GENOFFICE_RELAY || 'http://127.0.0.1:8787', family: null, schemaRevision: null, marker: 'WreCliKeep', timeout: 90_000, help: false, headless: process.env.GENOFFICE_HEADLESS === '1' }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--path') out.path = argv[++i]
    else if (arg === '--base') out.base = argv[++i]
    else if (arg === '--family') out.family = argv[++i]
    else if (arg === '--schema-revision') out.schemaRevision = argv[++i]
    else if (arg === '--marker') out.marker = argv[++i]
    else if (arg === '--timeout') out.timeout = Number(argv[++i])
    else if (arg === '--headless') out.headless = true
    else if (!arg.startsWith('--') && out.command === null) out.command = arg
    else rest.push(arg)
  }
  out.rest = rest
  return out
}

function fail(code, message, extra) {
  const payload = { ok: false, error: message, ...(extra || {}) }
  console.error(JSON.stringify(payload, null, 2))
  process.exit(code)
}

function ok(payload) {
  console.log(JSON.stringify({ ok: true, ...payload }, null, 2))
}

async function editMarkdown(client, file, marker, signal) {
  const first = await client.tool('markdown', file, 'apply_ops', {
    ops: [{ op: 'insertContent', after: 1, markdown: marker }],
  }, { signal })
  if (toolOk(first)) return first
  return client.tool('markdown', file, 'insert_content', { afterIndex: -1, markdown: marker }, { signal })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.command) {
    console.log(HELP)
    process.exit(args.help ? 0 : 1)
  }
  const client = new GenOfficeClient({
    base: args.base,
    family: args.family,
    schemaRevision: args.schemaRevision || undefined,
  })
  const headless = args.headless ? new HeadlessExecutor({ client }) : null
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  process.on('SIGINT', onAbort)
  process.on('SIGTERM', onAbort)
  try {
    if (args.command === 'discover') {
      const discovery = await client.discover(args.family ? { family: args.family } : {})
      if (discovery.status >= 400) fail(2, discovery.error || 'discovery failed', discovery)
      ok({ command: 'discover', discovery })
      return
    }
    if (!args.path) fail(1, '--path is required')
    const file = resolve(args.path.replace(/^~(?=\/)/, process.env.HOME ?? ''))
    const app = appForPath(file)
    if (!app) fail(1, `unsupported extension: ${file}`, { supported: Object.keys(APP_BY_EXT) })

    if (args.command === 'open') {
      const opened = headless
        ? await headless.open(file, { timeout: args.timeout })
        : await client.waitReady(file, { timeout: args.timeout, signal: ac.signal })
      if (opened.readiness !== 'ready') fail(2, opened.error || opened.readiness || 'not ready', opened)
      ok({ command: 'open', path: file, app, ...opened })
      return
    }
    if (args.command === 'context') {
      const ctx = await client.context(app, file)
      if (ctx.ok !== true) fail(2, ctx.error || 'context failed', ctx)
      ok({ command: 'context', path: file, app, context: ctx.context ?? toolOutput(ctx), revision: ctx.revision })
      return
    }
    if (args.command === 'edit') {
      if (app !== 'markdown') fail(1, 'edit currently implements markdown only; use SDK tool() for other families')
      const edited = await editMarkdown(client, file, args.marker, ac.signal)
      if (toolOk(edited) === false) fail(2, toolOutput(edited) || edited.error || 'edit failed', edited)
      ok({ command: 'edit', path: file, app, output: toolOutput(edited), revision: edited.revision })
      return
    }
    if (args.command === 'save') {
      const saved = await client.save(app, file, { signal: ac.signal })
      if (saved.ok !== true) fail(2, saved.error || 'save failed', saved)
      ok({ command: 'save', path: saved.path || file, app, mtimeMs: saved.mtimeMs })
      return
    }
    if (args.command === 'run') {
      if (app !== 'markdown') fail(1, 'run currently implements markdown only')
      const worker = headless || new HeadlessExecutor({ client })
      try {
        const opened = await worker.open(file, { timeout: args.timeout })
        if (opened.readiness !== 'ready') fail(2, opened.error || 'not ready', opened)
        const edited = await editMarkdown(client, file, args.marker, ac.signal)
        if (toolOk(edited) === false) fail(2, toolOutput(edited) || 'edit failed', edited)
        const saved = await client.save(app, file, { signal: ac.signal })
        if (saved.ok !== true) fail(2, saved.error || 'save failed', saved)
        await worker.release(file, { force: true })
        const reopened = await worker.open(file, { timeout: args.timeout })
        const ctx = await client.context(app, file)
        const disk = readFileSync(file, 'utf8')
        ok({
          command: 'run',
          path: file,
          app,
          spawned: opened.spawned === true,
          readiness: reopened.readiness,
          context: ctx.context ?? toolOutput(ctx),
          disk: disk.slice(0, 400),
          persisted: disk.includes(args.marker),
        })
      } finally {
        if (headless === null) await worker.close()
      }
      return
    }
    if (args.command === 'reopen') {
      const opened = headless
        ? await headless.open(file, { timeout: args.timeout })
        : await client.waitReady(file, { timeout: args.timeout, signal: ac.signal })
      if (opened.readiness !== 'ready') fail(2, opened.error || 'not ready', opened)
      const ctx = await client.context(app, file)
      ok({
        command: 'reopen',
        path: file,
        app,
        readiness: opened.readiness,
        revision: ctx.revision ?? opened.revision,
        context: ctx.context ?? toolOutput(ctx),
        disk: readFileSync(file, 'utf8').slice(0, 400),
      })
      return
    }
    fail(1, `unknown command: ${args.command}`)
  } catch (err) {
    if (err && (err.code === 'aborted' || err.name === 'AbortError')) fail(3, 'aborted')
    fail(2, err instanceof Error ? err.message : String(err))
  } finally {
    process.off('SIGINT', onAbort)
    process.off('SIGTERM', onAbort)
    if (headless) await headless.close()
  }
}

void main()
