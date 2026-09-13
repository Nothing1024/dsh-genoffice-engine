#!/usr/bin/env node
/**
 * Generate web/capability-manifest.json from the plugin CONTROL_TOOL_TABLE.
 * Single source: plugin packages/tab-genoffice/src/host/tool-schema.ts
 * plus write/read classification aligned with CAPABILITY (document mutation).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(process.env.PLUGIN_ROOT || '/Users/nothing/workspace/dsh/plugin/dsh-genoffice/plugin')
const SCHEMA = join(PLUGIN, 'packages/tab-genoffice/src/host/tool-schema.ts')
const OUT = join(HERE, 'capability-manifest.json')

const PROTOCOL = 'genoffice-control'
const PROTOCOL_VERSION = '1.0.0'
const SCHEMA_REVISION = '2026.09.1'

/** Skills that do not mutate document bytes (28 of 100 tools). */
const READ_SKILLS = new Set([
  'get_document_context',
  'read_blocks',
  'read_comments',
  'read_revisions',
  'get_workbook_context',
  'read_range',
  'load_guide',
  'read_formats',
  'read_sheet_features',
  'read_cells',
  'aggregate_range',
  'find_cells',
  'select_range',
  'trace_precedents',
  'trace_dependents',
  'get_deck_context',
  'read_slide',
  'list_style_templates',
  'read_pages',
  'search_text',
  'goto_page',
  'list_page_images',
  'list_form_fields',
  'get_outline',
  'read_source',
])

const PATH_PARAM = {
  type: 'string',
  required: true,
  description: '目标文件的本机绝对路径（必须与 GenOffice tab 中打开的文件一致）',
}
const SAVE_AS_PARAM = {
  type: 'string',
  description: '冲突时另存到该绝对路径，不覆盖已存在文件',
}
const SAVE_PARAMS = { path: PATH_PARAM, save_as: SAVE_AS_PARAM }

function extractTable(src) {
  const start = src.indexOf('export const CONTROL_TOOL_TABLE')
  if (start < 0) throw new Error('CONTROL_TOOL_TABLE not found')
  const open = src.indexOf('= [', start)
  if (open < 0) throw new Error('CONTROL_TOOL_TABLE array not found')
  const brace = open + 2
  let depth = 0
  let end = -1
  for (let i = brace; i < src.length; i++) {
    const ch = src[i]
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) throw new Error('CONTROL_TOOL_TABLE unterminated')
  return src.slice(brace + 1, end)
}

function splitEntries(tableInner) {
  const entries = []
  let depth = 0
  let start = -1
  for (let i = 0; i < tableInner.length; i++) {
    const ch = tableInner[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        entries.push(tableInner.slice(start, i + 1))
        start = -1
      }
    }
  }
  return entries
}

function fieldString(block, key) {
  const m = block.match(new RegExp(`${key}:\\s*'([^']+)'`))
  if (!m) throw new Error(`missing ${key} in ${block.slice(0, 80)}`)
  return m[1]
}

function extractParameters(block) {
  const idx = block.search(/parameters:\s/)
  if (idx < 0) throw new Error('missing parameters')
  const rest = block.slice(idx + 'parameters:'.length).trim()
  if (rest.startsWith('SAVE_PARAMS')) return SAVE_PARAMS
  if (rest.startsWith('{')) {
    let depth = 0
    let end = -1
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '{') depth++
      else if (rest[i] === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    const raw = rest.slice(0, end + 1)
      .replace(/\bas const\b/g, '')
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']')
    try {
      return Function('PATH_PARAM', 'SAVE_AS_PARAM', `"use strict"; return (${raw})`)(PATH_PARAM, SAVE_AS_PARAM)
    } catch (err) {
      return { path: PATH_PARAM, _unparsed: true, error: String(err.message) }
    }
  }
  throw new Error(`unrecognized parameters: ${rest.slice(0, 40)}`)
}

function main() {
  const src = readFileSync(SCHEMA, 'utf8')
  const entries = splitEntries(extractTable(src))
  const tools = entries.map((block) => {
    const name = fieldString(block, 'name')
    const skillName = fieldString(block, 'skillName')
    const app = fieldString(block, 'app')
    const parameters = extractParameters(block)
    const write = !READ_SKILLS.has(skillName)
    return { name, skillName, app, parameters, write }
  })
  if (tools.length !== 100) {
    throw new Error(`expected 100 tools, got ${tools.length}`)
  }
  const byApp = {}
  let writes = 0
  for (const tool of tools) {
    byApp[tool.app] = (byApp[tool.app] || 0) + 1
    if (tool.write) writes++
  }
  const expected = { docs: 16, markdown: 6, sheets: 13, slides: 39, pdf: 21, html: 5 }
  for (const [app, count] of Object.entries(expected)) {
    if (byApp[app] !== count) throw new Error(`${app} expected ${count} got ${byApp[app]}`)
  }
  if (writes !== 72) throw new Error(`expected 72 writes, got ${writes}`)

  const unparsed = tools.filter((t) => t.parameters && t.parameters._unparsed)
  if (unparsed.length) {
    throw new Error(`unparsed parameters: ${unparsed.map((t) => t.name).join(',')}`)
  }

  const manifest = {
    protocol: PROTOCOL,
    protocol_version: PROTOCOL_VERSION,
    schema_revision: SCHEMA_REVISION,
    supported_schema_revisions: [SCHEMA_REVISION],
    generated_from: 'packages/tab-genoffice/src/host/tool-schema.ts CONTROL_TOOL_TABLE',
    families: {
      docs: { app: 'docs', aliases: ['docs', 'docx', 'word'], open: 'docx_open', ext: ['.docx'] },
      markdown: { app: 'markdown', aliases: ['markdown', 'md'], open: 'md_open', ext: ['.md', '.markdown'] },
      sheets: { app: 'sheets', aliases: ['sheets', 'xlsx'], open: 'xlsx_open', ext: ['.xlsx'] },
      slides: { app: 'slides', aliases: ['slides', 'pptx'], open: 'pptx_open', ext: ['.pptx'] },
      pdf: { app: 'pdf', aliases: ['pdf'], open: 'pdf_open', ext: ['.pdf'] },
      html: { app: 'html', aliases: ['html', 'htm'], open: 'html_open', ext: ['.html', '.htm'] },
    },
    tools,
    counts: { total: tools.length, write: writes, read: tools.length - writes, byApp },
  }
  writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(JSON.stringify({ out: OUT, ...manifest.counts }, null, 2))
}

main()
