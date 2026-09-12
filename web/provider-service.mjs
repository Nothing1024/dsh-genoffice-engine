/**
 * Isolated web provider readiness + fixture backends.
 * Live search/GSK paths stay in server.mjs; this module only decides
 * availability and supplies deterministic fixture/error/echo adapters.
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CREDIT_USAGE_URL = 'https://www.genspark.ai/credit-usage'
const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function gskApiKey() {
  if (process.env.GENOFFICE_GSK_DISABLED === '1') return ''
  if (process.env.GSK_API_KEY) return process.env.GSK_API_KEY
  try {
    const configPath = join(homedir(), '.genspark-tool-cli', 'config.json')
    if (!existsSync(configPath)) return ''
    return JSON.parse(readFileSync(configPath, 'utf8')).api_key ?? ''
  } catch {
    return ''
  }
}

function ocrHelper() {
  if (process.env.GENOFFICE_OCR_HELPER && existsSync(process.env.GENOFFICE_OCR_HELPER)) {
    return process.env.GENOFFICE_OCR_HELPER
  }
  const helper = process.platform === 'darwin'
    ? join(ROOT, 'packages/pdf2docx/ocr-helper/vision-ocr')
    : join(ROOT, 'packages/pdf2docx/ocr-helper/win-ocr.exe')
  return existsSync(helper) ? helper : ''
}

export function providersReady() {
  const searchDisabled = process.env.GENOFFICE_SEARCH_DISABLED === '1'
  const gsk = Boolean(gskApiKey())
  const generateFixture = process.env.GENOFFICE_GENERATE_FIXTURE === '1'
  const analyzeFixture = process.env.GENOFFICE_ANALYZE_FIXTURE === '1'
  const modelDisabled = process.env.GENOFFICE_MODEL_DISABLED === '1'
  return {
    search: {
      available: !searchDisabled,
      reason: searchDisabled ? 'search-service-disabled' : undefined,
      fixture: process.env.GENOFFICE_SEARCH_FIXTURE === '1',
    },
    imageSearch: {
      available: !searchDisabled,
      reason: searchDisabled ? 'search-service-disabled' : undefined,
      fixture: process.env.GENOFFICE_SEARCH_FIXTURE === '1',
    },
    generate: {
      available: gsk || generateFixture,
      reason: gsk || generateFixture ? undefined : 'generate-provider-unconfigured',
      fixture: generateFixture,
    },
    analyze: {
      available: gsk || analyzeFixture,
      reason: gsk || analyzeFixture ? undefined : 'analyze-provider-unconfigured',
      fixture: analyzeFixture && !gsk,
    },
    model: {
      available: !modelDisabled,
      reason: modelDisabled ? 'model-service-disabled' : undefined,
      echo: true,
    },
    credit: {
      available: gsk,
      reason: gsk ? undefined : 'credit-provider-unconfigured',
      url: CREDIT_USAGE_URL,
    },
  }
}

export function searchFixture(kind, query) {
  if (process.env.GENOFFICE_SEARCH_FAIL === '1') {
    return kind === 'image'
      ? { images: [], method: 'error', error: 'search-runtime-error' }
      : { results: [], method: 'error', error: 'search-runtime-error' }
  }
  const q = String(query ?? 'WfcSearchKeep')
  if (kind === 'image') {
    return {
      images: [
        {
          title: `WfcSearchKeep ${q}`,
          imageUrl: 'https://example.com/wfc-search.png',
          sourceUrl: 'https://example.com/wfc-search',
          source: 'fixture',
          width: 64,
          height: 64,
        },
      ],
      method: 'fixture',
    }
  }
  return {
    results: [
      {
        title: `WfcSearchKeep ${q}`,
        url: 'https://example.com/wfc-search',
        snippet: 'WfcSearchKeep fixture result',
      },
    ],
    method: 'fixture',
    answer: 'WfcSearchKeep',
  }
}

export async function generateFixture(op = {}) {
  if (process.env.GENOFFICE_GENERATE_FAIL === '1') {
    return { error: 'generate-runtime-error' }
  }
  const dest = typeof op.dest === 'string' ? op.dest : ''
  if (dest && (dest.startsWith('/') === false || dest.includes('..'))) {
    return { error: 'invalid dest' }
  }
  if (dest) {
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, FIXTURE_PNG)
    return { url: dest, dest, fixture: true }
  }
  return { url: `data:image/png;base64,${FIXTURE_PNG.toString('base64')}`, fixture: true }
}

export async function analyzeFixture(op = {}) {
  if (process.env.GENOFFICE_ANALYZE_FAIL === '1') {
    return { error: 'analyze-runtime-error' }
  }
  const pngBase64 = typeof op.pngBase64 === 'string' ? op.pngBase64 : ''
  const helper = ocrHelper()
  if (pngBase64 && helper) {
    const png = Buffer.from(pngBase64, 'base64')
    const res = spawnSync(helper, [], { input: png, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 })
    if (res.status === 0 && res.stdout) {
      try {
        const parsed = JSON.parse(res.stdout.toString('utf8').replace(/^\uFEFF/, ''))
        const text = (parsed.lines ?? []).map((l) => l.t).join('\n').trim()
        if (text) return { text, method: 'ocr-helper' }
      } catch {
        /* fall through */
      }
    }
  }
  return { text: `WfcMediaKeep ${String(op.requirements ?? '').trim()}`.trim(), method: 'fixture' }
}

export function modelChat(body = {}) {
  if (process.env.GENOFFICE_MODEL_DISABLED === '1') {
    return { ok: false, available: false, error: 'model-service-disabled' }
  }
  if (process.env.GENOFFICE_MODEL_FAIL === '1') {
    return { ok: false, error: 'model-runtime-error' }
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  const last = [...messages].reverse().find((m) => m && m.role === 'user')
  const content = typeof last?.content === 'string' ? last.content : 'ping'
  const text = `WfcModelKeep ${content}`.trim()
  return { ok: true, text, model: 'echo' }
}

export function modelChatCompletionsSse(body = {}) {
  const result = modelChat(body)
  if (!result.ok) {
    return { status: 503, body: JSON.stringify({ error: { message: result.error } }) }
  }
  const chunk = JSON.stringify({
    id: 'echo',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: result.text } }],
  })
  return {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    body: `data: ${chunk}\n\ndata: [DONE]\n\n`,
  }
}
