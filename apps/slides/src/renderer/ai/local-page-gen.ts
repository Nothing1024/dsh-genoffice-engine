/**
 * Shared local page-generation prompts + retry (desktop AiPanel and web
 * control-mode DeckAccess). The LLM writes one JSON slide spec; landing
 * (`localGeneratePage` → marker → htmlToPptx) is owned by the host.
 */
import { extractJsonObject, parseOutlineJson } from './outline-json'
import type { DeckAccess } from './slides-skill'

export type LocalPageGenArgs = NonNullable<DeckAccess['generatePageLocal']> extends (
  args: infer A,
) => unknown
  ? A
  : never

export type LocalPageGenResult = Awaited<
  NonNullable<DeckAccess['generatePageLocal']> extends (...args: never) => infer R ? R : never
>

export type StyleSkillArgs = NonNullable<DeckAccess['generateStyleSkill']> extends (
  args: infer A,
) => unknown
  ? A
  : never

export type PlanDeckArgs = NonNullable<DeckAccess['planDeckOutline']> extends (
  args: infer A,
) => unknown
  ? A
  : never

export type LlmResult = {
  ok: boolean
  text?: string
  error?: string
  errKind?: 'timeout' | 'empty' | 'stopped'
}

export type RunLlmOnce = (
  system: string,
  user: string,
  timeoutMs?: number,
  useGenModel?: boolean,
  signal?: AbortSignal,
  maxTokens?: number,
) => Promise<LlmResult>

export function pageSpecSystemPrompt(canvasW: number, canvasH: number): string {
  return (
    'You are a professional slide visual designer. Output exactly ONE JSON object describing one slide; no explanations/markdown/code fences.\n' +
    '\n' +
    '## Canvas\n' +
    `${canvasW}x${canvasH} px, origin top-left. All x/y/w/h are integers in px. Nothing may cross the canvas edges; negative coordinates forbidden. Elements paint in array order: background/decor shapes first, then images, text last (text must never end up underneath a shape).\n` +
    '\n' +
    '## Format\n' +
    '{"background":"#RRGGBB","elements":[...]}\n' +
    'Element types:\n' +
    '- Shape: {"type":"shape","shape":"roundRect","x":80,"y":120,"w":360,"h":200,"fill":"#RRGGBB or #RRGGBBAA (AA=alpha, 00 transparent)","stroke":{"color":"#RRGGBB","widthPt":1},"paragraphs":[...optional label text, vertically centered...]}\n' +
    '  Allowed shape values: rect, roundRect, ellipse, triangle, rightArrow, leftArrow, upArrow, downArrow, chevron, diamond, parallelogram, trapezoid, hexagon, pentagon, pie, donut, star5, heart, cloud, line, lineArrow. line/lineArrow draw the diagonal of their box from top-left to bottom-right and need a stroke (a horizontal rule = a box with h:1).\n' +
    '- Text: {"type":"text","x":80,"y":60,"w":800,"h":90,"valign":"top","paragraphs":[{"align":"left","lineSpacingPct":110,"spaceAfterPt":6,"bullet":false,"runs":[{"text":"...","sizePt":18,"bold":true,"italic":false,"color":"#RRGGBB","font":"Font Name"}]}]}\n' +
    '  A paragraph may mix runs of different weight/color/size (e.g. a big number run + a small unit run in one line).\n' +
    '- Image: {"type":"image","url":"https://...","x":660,"y":80,"w":540,"h":560} — center-cropped to fill its box (object-fit: cover).\n' +
    '\n' +
    '## Hard layout rules\n' +
    '- Text boxes have ZERO inner padding: the box top-left is exactly where the first glyph starts. Size every box from its content: one line is about sizePt*1.8 px tall at lineSpacingPct 110; a CJK character is about sizePt*1.35 px wide, a Latin character about sizePt*0.7 px. Text wraps at the box width — count the wrapped lines and make the box tall enough, plus one spare line.\n' +
    '- Text must never overflow its box or overlap other text. Keep >=8px between text and card edges, >=20px between a big title and its subtitle, >=5px between stacked text blocks in the same column — self-check every pair before output.\n' +
    '- Font sizes in pt: big titles 32-48, subtitles 18-24, body 12-15, hero KPI numbers up to 80.\n' +
    '- Spread content across the whole page; do not cram it into the top half leaving large blank areas; make text and images as large as the layout allows.\n' +
    '\n' +
    '## Visuals and assets\n' +
    '- Photos may only use URLs from the "available images" list, at most as many image elements as URLs. With no available images, fill with typography/color blocks/shapes — never fake photos.\n' +
    '- Icon-like decoration uses the allowed shapes only (at most 4-5 per page, strongly content-related). **Never use emoji**.\n' +
    '- Data visuals: compose bars/rings/timelines from rect/donut/line shapes with sizes proportional to the real values from the brief.\n' +
    '- Solid colors only (alpha allowed) — no gradients. **No placeholders of any kind**: all copy comes from the brief’s real content.\n' +
    '\n' +
    '## Anti-AI design rules (violation = unacceptable)\n' +
    '- No thin vertical accent bar on the left of cards, no colored bar on top of cards, no small bar left of titles — express hierarchy with background color/font weight/size contrast.\n' +
    '- One primary + one secondary accent color for the whole page; even when comparing multiple entities, do not give each a different color (no rainbow cards).\n' +
    '- No decorative corner blocks/short lines; decorative elements must be consistent in position and style across the deck.\n' +
    '- Do not turn every page into a "shape + bold subtitle + description" list; the cover must not be a flat one-line title + subtitle layout — it needs a visual anchor (large color block/geometric composition/huge number/hero image).'
  )
}

export function pageSpecUserMessage(args: LocalPageGenArgs): string {
  const imgBlock = args.images.length
    ? `\nAvailable image URLs (put them into image elements; do not invent placeholder blocks):\n${args.images.map((u, i) => `${i + 1}. ${u}`).join('\n')}`
    : ''
  const ctxBlock = args.context
    ? `\n\nReference material (all real names/figures/facts come from here; do not invent):\n${args.context.slice(0, 4000)}`
    : ''
  return (
    `This is the deck's unified style (this page must follow it strictly to stay consistent across pages):\n${args.style}\n\n` +
    (args.topic ? `Deck topic: ${args.topic}\n` : '') +
    `Deck-wide narrative Core Hook: ${args.coreHook}\n\n` +
    `Now design page ${args.pageIndex}/${args.totalPages}.\n` +
    `Title: ${args.title}\nLayout: ${args.layout}\nContent brief (use real data/facts): ${args.brief}${imgBlock}${ctxBlock}\n\n` +
    "Return only this page's spec JSON."
  )
}

export const STYLE_SKILL_SYSTEM_PROMPT =
  'You are a professional deck visual designer. Given the presentation topic and style preferences, produce a complete Style Skill (visual style guide). Output strictly in the structure below, only the Style Skill content, no explanations/markdown/code fences.\n\n' +
  'Color rules (must use concrete hex values)\n' +
  '  Main background: #hex\n' +
  '  Per-page-type backgrounds:\n    cover: #hex\n    content: #hex\n    data: #hex\n    closing: #hex\n' +
  '  (Background selection principles, highest priority first):\n' +
  '   1) Style preference first: when a tone is explicit (dark theme, a brand color family, a certain texture), the background must honor it — do not fall back to a safe light color.\n' +
  "   2) Then topic mood: serve the content's emotion and tone (serious/playful/artistic/tech/traditional); different topics should have clearly different backgrounds. Dark colors, brand colors, and saturated light colors are all legitimate choices.\n" +
  '   3) Light neutral backgrounds are only a fallback: use only when the topic is neutral and the style expresses no clear preference.\n' +
  '   Constraints: content pages share one background within a deck; the main background and main text color must have sufficient contrast (light text on dark, dark text on light).\n' +
  '  Main text color: #hex\n  Primary accent: #hex\n  Secondary accent: #hex\n' +
  '  (Iron rule: one accent color system across the whole deck — even when comparing multiple companies/products/options, do not assign each entity a different color; distinguish entities by name and typography. Never exceed the primary + secondary accents)\n' +
  '  Card background: #hex\n  Border color: #hex\n\n' +
  'Fonts\n  CJK title font: [font name]\n  Latin title font: [font name]\n  Body font: [font name]\n  Title size: [range]px\n  Body size: [range]px\n\n' +
  'Layout variants per page type (list at least 2 variants each, format: variant name: description)\n' +
  '  cover variants:\n    cover_full_image_overlay: full-bleed photo background + dark overlay, centered white title, bottom metadata bar\n    cover_split_color: two color blocks side by side (60/40)\n    cover_typography_hero: pure typography, no photo, huge title (100px+)\n    cover_dark_minimal: dark background, centered large title + a little accent color\n    cover_magazine: magazine-style title taking 60% + partial imagery\n    cover_split_image: title on the left half + hero image on the right half\n' +
  '  content variants:\n    left_text_right_image | three_column_cards | hero_big_number | two_column_comparison | timeline_horizontal | full_image_text_overlay (give each a one-line description)\n' +
  '  data variants:\n    kpi_cards_row: horizontal KPI cards\n    chart_with_insight: chart left + insight right\n    two_by_two_grid: 2x2 quadrants\n' +
  '  closing variants:\n    closing_cta: centered title + contact info\n    closing_thank_you: full-bleed thank-you page\n\n' +
  'Overall style: [one sentence describing the overall design language]'

export function styleSkillUserMessage(a: StyleSkillArgs): string {
  const q = a.questionnaire ? `\nUser questionnaire answers: ${a.questionnaire}` : ''
  const hint = a.styleHint ? `\nStyle preference: ${a.styleHint}` : ''
  return `Topic and style preferences: ${a.topic}${hint}${q}\nOutput the Style Skill.`
}

export const PLAN_DECK_SYSTEM_PROMPT =
  'You are a professional deck planner. Given the confirmed design style, plan the content page by page. Output only one JSON object, no explanations/markdown/code fences.\n' +
  'Format: {"core_hook":"...","pages":[{"title":"","type":"cover|content|data|closing","brief":"","layout":"","image_queries":[]}]}\n' +
  '\n' +
  '## core_hook\n' +
  "The deck's narrative anchor: one sentence, with tension, containing a number or counter-intuitive contrast, at most 20 characters.\n" +
  '\n' +
  "## layout (choose from the Style Skill's per-page-type variant library; content pages within one deck must not repeat the same variant)\n" +
  'cover: cover_typography_hero (huge pure typography) | cover_dark_minimal (dark background, centered large title) | cover_split_color (side-by-side color blocks) | cover_full_image_overlay (full-bleed photo + dark overlay) | cover_magazine (magazine-style large title + partial imagery) | cover_split_image (text left, image right)\n' +
  'content: left_text_right_image | three_column_cards | hero_big_number | two_column_comparison | timeline_horizontal | full_image_text_overlay\n' +
  'data: kpi_cards_row | chart_with_insight | two_by_two_grid\n' +
  'closing: closing_cta | closing_thank_you\n' +
  'Selection criteria: 3 parallel points → three_column_cards; a key number → hero_big_number; comparison/categories → two_column_comparison/two_by_two_grid; sequence → timeline_horizontal; image+text → left_text_right_image/full_image_text_overlay; metrics → kpi_cards_row.\n' +
  '\n' +
  '## brief\n' +
  'Describe in detail what goes in each region of the layout; prefer real data/facts from the reference material, no "XX%" placeholders; cover gives main/sub titles and mood; data gives metric names + concrete values + changes.\n' +
  '\n' +
  '## image_queries\n' +
  'Array: one entry per photo slot on the page. If the reference material contains ready image URLs (starting with http), use them directly; otherwise put English image-search keywords (describing a concrete scene, e.g. "summer palace kunming lake", not generic words like "park") — the system auto-searches and fills real URLs back. Travel/product/people/brand pages get images by default; give [] only when the page truly needs no photos (fill with typography/icons; never count on CSS-drawn fake images).'

export function planDeckUserMessage(a: PlanDeckArgs): string {
  const styleBlock = a.styleSkill
    ? `\n[Confirmed design style Style Skill; choose layout accordingly while planning]:\n${a.styleSkill}`
    : ''
  const contHint = a.continueFrom
    ? `\nThis continues the earlier plan starting at page ${a.startPage}, ${a.count} pages in total; stay narratively coherent with what came before. Core Hook: ${a.continueFrom.coreHook}. Return only these ${a.count} pages' pages (core_hook identical to before).`
    : `\nPlan ${a.count} pages in total.`
  return `Topic: ${a.topic}${a.context ? `\nReference material/requirements: ${a.context}` : ''}${styleBlock}${contHint}\nOutput the JSON.`
}

export async function generatePageLocalWithLlm(
  args: LocalPageGenArgs,
  runLlmOnce: RunLlmOnce,
  emptyError: string,
  unknownError: string,
): Promise<LocalPageGenResult> {
  const sys = pageSpecSystemPrompt(args.canvasW, args.canvasH)
  const userMsg = pageSpecUserMessage(args)
  let lastErr = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    if (args.signal?.aborted) break
    const msg =
      attempt === 0
        ? userMsg
        : `${userMsg}\n\nYour previous output was rejected: ${lastErr}. Output the corrected JSON object only.`
    const r = await runLlmOnce(sys, msg, 120000, true, args.signal, 16384)
    if (!r.ok || !r.text) {
      lastErr = r.error ?? emptyError
      continue
    }
    try {
      const res = await window.slidesApi.localGeneratePage({ specJson: r.text })
      if (res?.ok && res.marker) return res
      lastErr = res?.error ?? unknownError
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }
  return { ok: false, error: lastErr || unknownError }
}

export async function generateStyleSkillWithLlm(
  a: StyleSkillArgs,
  runLlmOnce: RunLlmOnce,
  emptyError: string,
): Promise<{ ok: boolean; styleSkill?: string; error?: string }> {
  const r = await runLlmOnce(STYLE_SKILL_SYSTEM_PROMPT, styleSkillUserMessage(a), undefined, true, a.signal)
  return r.ok && r.text
    ? { ok: true, styleSkill: r.text.trim() }
    : { ok: false, error: r.error ?? emptyError }
}

export async function planDeckOutlineWithLlm(
  a: PlanDeckArgs,
  runLlmOnce: RunLlmOnce,
  emptyError: string,
  stoppedError: string,
): Promise<{
  ok: boolean
  outline?: { core_hook?: unknown; pages?: unknown }
  error?: string
}> {
  const userMsg = planDeckUserMessage(a)
  const parseOutline = (text: string) => {
    const obj = parseOutlineJson(text)
    if (obj) return { ok: true as const, outline: obj }
    let detail = 'output is not valid JSON'
    try {
      JSON.parse(extractJsonObject(text))
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e)
    }
    return { ok: false as const, error: 'outline JSON parse failed: ' + detail }
  }
  let lastErr = emptyError
  for (let attempt = 0; attempt < 2; attempt++) {
    if (a.signal?.aborted) return { ok: false, error: stoppedError }
    const r = await runLlmOnce(PLAN_DECK_SYSTEM_PROMPT, userMsg, undefined, true, a.signal)
    if (!r.ok || !r.text) {
      lastErr = r.error ?? emptyError
      if (r.errKind === 'timeout' || r.errKind === 'empty' || r.errKind === 'stopped') break
      continue
    }
    const parsed = parseOutline(r.text)
    if (parsed.ok) return parsed
    lastErr = parsed.error
  }
  return { ok: false, error: lastErr }
}
