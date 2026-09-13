import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

export const MANIFEST = JSON.parse(readFileSync(join(HERE, 'capability-manifest.json'), 'utf8'))

export const PROTOCOL = MANIFEST.protocol
export const PROTOCOL_VERSION = MANIFEST.protocol_version
export const SCHEMA_REVISION = MANIFEST.schema_revision
export const SUPPORTED_REVISIONS = MANIFEST.supported_schema_revisions

const FAMILY_BY_ALIAS = new Map()
for (const [key, fam] of Object.entries(MANIFEST.families)) {
  const record = { key, ...fam }
  FAMILY_BY_ALIAS.set(key, record)
  for (const alias of fam.aliases) FAMILY_BY_ALIAS.set(String(alias).toLowerCase(), record)
  for (const ext of fam.ext || []) FAMILY_BY_ALIAS.set(String(ext).toLowerCase().replace(/^\./, ''), record)
}

function header(headers, name) {
  if (!headers) return ''
  const direct = headers[name] ?? headers[name.toLowerCase()]
  if (typeof direct === 'string') return direct
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    if (typeof value === 'string') return value
  }
  return ''
}

export function resolveFamily(token) {
  if (token == null || token === '') return null
  const raw = String(token).trim().toLowerCase()
  if (!raw) return null
  const stripped = raw.replace(/^\./, '')
  return FAMILY_BY_ALIAS.get(raw) || FAMILY_BY_ALIAS.get(stripped) || null
}

export function clientContractFrom({ headers = {}, query = {}, body = {} } = {}) {
  const q = query && typeof query === 'object' ? query : {}
  const b = body && typeof body === 'object' ? body : {}
  return {
    schema_revision: String(header(headers, 'x-genoffice-schema-revision') || q.schema_revision || b.schema_revision || ''),
    family: String(header(headers, 'x-genoffice-family') || q.family || q.app || q.ext || b.family || b.app || b.ext || ''),
    protocol: String(header(headers, 'x-genoffice-protocol') || q.protocol_version || q.protocol || b.protocol_version || b.protocol || ''),
  }
}

function protocolOk(value) {
  if (!value) return true
  return value === PROTOCOL || value === PROTOCOL_VERSION
}

function revisionOk(value) {
  if (!value) return true
  return SUPPORTED_REVISIONS.includes(value)
}

function publicEntries(family) {
  const base = [
    { name: 'discovery', path: '/api/discovery' },
    { name: 'health', path: '/api/health' },
    { name: 'open', path: '/api/control/open' },
  ]
  if (family) {
    base.push({ name: family.open })
    return base
  }
  for (const fam of Object.values(MANIFEST.families)) base.push({ name: fam.open })
  return base
}

function toolsFor(app) {
  if (!app) return MANIFEST.tools
  return MANIFEST.tools.filter((tool) => tool.app === app)
}

export function isWriteTool(app, skillName) {
  if (!skillName) return true
  const hit = MANIFEST.tools.find((tool) => tool.app === app && tool.skillName === skillName)
  if (!hit) return true
  return hit.write === true
}

function errorBody(error, extra = {}) {
  return {
    ok: false,
    error,
    protocol: PROTOCOL,
    protocol_version: PROTOCOL_VERSION,
    schema_revision: SCHEMA_REVISION,
    supported_schema_revisions: SUPPORTED_REVISIONS,
    tools: [],
    refresh: { url: '/api/discovery' },
    ...extra,
  }
}

function familyState(app, appsReady) {
  const ready = appsReady?.[app] === true || existsSync(join(ROOT, 'apps', app, 'web-dist', 'index.html'))
  return { ready, state: ready ? 'family-loaded' : 'dependency-missing' }
}

export function buildDiscovery(input = {}) {
  const {
    family,
    app,
    ext,
    mode,
    schema_revision,
    protocol_version,
    appsReady = {},
  } = input

  if (protocol_version && !protocolOk(protocol_version)) {
    return { httpStatus: 409, body: errorBody('protocol-version-unsupported') }
  }
  if (schema_revision && !revisionOk(schema_revision)) {
    return { httpStatus: 409, body: errorBody('schema-revision-unsupported') }
  }

  const token = family || app || ext || ''
  const resolved = token ? resolveFamily(token) : null
  if (token && !resolved) {
    return {
      httpStatus: 404,
      body: errorBody('family-unsupported', { mode: 'family', family: String(token), state: 'incompatible' }),
    }
  }

  const familyMode = mode === 'family' || Boolean(resolved)
  if (familyMode && !resolved) {
    return {
      httpStatus: 404,
      body: errorBody('family-unsupported', { mode: 'family', state: 'incompatible' }),
    }
  }

  const tools = familyMode ? toolsFor(resolved.app) : MANIFEST.tools
  const encoded = JSON.stringify(tools)
  const { ready, state } = familyMode
    ? familyState(resolved.app, appsReady)
    : { ready: Object.values(MANIFEST.families).every((fam) => appsReady?.[fam.app] !== false), state: 'compatible' }

  const families = {}
  for (const [key, fam] of Object.entries(MANIFEST.families)) {
    const info = familyState(fam.app, appsReady)
    if (!familyMode || fam.app === resolved.app) {
      families[key] = { app: fam.app, aliases: fam.aliases, ready: info.ready, open: fam.open }
    }
  }

  return {
    httpStatus: 200,
    body: {
      ok: true,
      protocol: PROTOCOL,
      protocol_version: PROTOCOL_VERSION,
      schema_revision: SCHEMA_REVISION,
      supported_schema_revisions: SUPPORTED_REVISIONS,
      mode: familyMode ? 'family' : 'compatible',
      family: familyMode ? resolved.key : null,
      state,
      ready,
      families,
      public: publicEntries(familyMode ? resolved : null),
      tools,
      schema_bytes: Buffer.byteLength(encoded),
      tool_count: tools.length,
      refresh: { url: familyMode ? `/api/discovery?family=${resolved.key}` : '/api/discovery' },
    },
  }
}

export function checkWriteContract({ headers = {}, query = {}, body = {}, app, skillName, op } = {}) {
  const client = clientContractFrom({ headers, query, body })
  const declared = Boolean(client.schema_revision || client.family || client.protocol)
  if (!declared) return { ok: true, legacy: true }

  const write = op === 'export' || isWriteTool(app, skillName)
  if (!write) return { ok: true, legacy: false, write: false }

  if (client.protocol && !protocolOk(client.protocol)) {
    return { ok: false, httpStatus: 409, body: errorBody('protocol-version-unsupported') }
  }
  if (client.schema_revision && !revisionOk(client.schema_revision)) {
    return { ok: false, httpStatus: 409, body: errorBody('schema-revision-unsupported') }
  }
  if (client.family) {
    const resolved = resolveFamily(client.family)
    if (!resolved) {
      return { ok: false, httpStatus: 409, body: errorBody('family-unsupported', { family: client.family }) }
    }
    if (app && resolved.app !== app) {
      return { ok: false, httpStatus: 409, body: errorBody('family-unsupported', { family: client.family, app }) }
    }
  }
  return { ok: true, legacy: false, write: true }
}
