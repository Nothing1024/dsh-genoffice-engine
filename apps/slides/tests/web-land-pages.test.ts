/**
 * Host-authored land_pages: parse all PageSpecs first, localGeneratePage →
 * htmlToPptx, then htmlGenerated unlocks native add_text_box. Control-mode
 * topic-only generate_deck / plan_deck must fail without touching BYOK LLM.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createSlidesSkill, clearSkillStateCache, type DeckAccess } from '../src/renderer/ai/slides-skill'
import { createControlDeckAccess } from '../src/renderer/ai/control-deck-access'
import { parsePageSpec, buildPagePptx } from '../src/shared/page-spec'
import { clearIssuedCloudPages, issueCloudPage } from '../src/shared/cloud-page-marker'
import {
  getWebSession,
  webHtmlToPptx,
  webNewBlank,
} from '../src/renderer/web-slides-session'
import type { RenderSlide } from '@genoffice/pptx-render'
import type { AgentToolCall } from '../src/shared/ipc'
import type { TextElement } from '@genoffice/pptx-engine'

const noImages = { fetchImage: async () => null }

const pageSpec = (text: string) => ({
  background: '#16395C',
  elements: [
    {
      type: 'text',
      x: 80,
      y: 80,
      w: 1120,
      h: 80,
      valign: 'top',
      paragraphs: [
        { align: 'left', runs: [{ text, sizePt: 32, bold: true, color: '#FFFFFF' }] },
      ],
    },
  ],
})

const tool = (name: string, input: Record<string, unknown>): AgentToolCall => ({
  id: 't',
  name,
  input,
})

let pageSeq = 0
async function localGeneratePage(op: { specJson: string }) {
  const parsed = parsePageSpec(String(op?.specJson ?? ''))
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const { bytes, imageFailures } = await buildPagePptx(parsed.spec, noImages)
  pageSeq += 1
  return {
    ok: true,
    marker: issueCloudPage(bytes, `p${pageSeq}`),
    ...(imageFailures.length ? { imageFailures } : {}),
  }
}

function deckTexts(): string[] {
  const session = getWebSession()
  if (!session) return []
  return session.opened.deck.slides.flatMap((s) =>
    s.elements
      .filter((e): e is TextElement => e.type === 'text')
      .flatMap((el) => el.text?.paragraphs.flatMap((p) => p.runs.map((run) => run.text)) ?? []),
  )
}

describe('web land_pages', () => {
  const applyDeck = (slides: RenderSlide[]) => {
    void slides
  }

  const access: DeckAccess = {
    getSlides: () =>
      getWebSession()
        ? [{ widthPx: 1280, heightPx: 720, scale: 1, nodes: [] } as unknown as RenderSlide]
        : [],
    getCurrent: () => 0,
    getSelectedIds: () => [],
    applySlide: () => {},
    applyDeck,
    fitWidthPx: 1280,
    retryBackoffMs: 0,
    isCloudPageGenEnabled: async () => false,
    generateFromHtml: async (pagesHtml, mode = 'replace', _deckName, insertAt) => {
      const res = await webHtmlToPptx(pagesHtml, 1280, mode, insertAt)
      if ('error' in res) return { ok: false, error: res.error }
      applyDeck(res.slides)
      return {
        ok: true,
        pages: res.slides.length,
        appendedFrom: res.appendedFrom,
        insertedIndex: res.insertedIndex,
      }
    },
    regenerateSlide: async (slideIndex, html) => {
      const res = await webHtmlToPptx([html], 1280, 'replace_at', slideIndex)
      if ('error' in res) return { ok: false, error: res.error }
      applyDeck(res.slides)
      return { ok: true, pages: res.slides.length }
    },
  }

  beforeEach(async () => {
    clearSkillStateCache()
    pageSeq = 0
    clearIssuedCloudPages()
    await webNewBlank(1280)
    ;(window as { slidesApi?: unknown }).slidesApi = {
      localGeneratePage,
      addElement: vi.fn(async () => ({
        slide: { widthPx: 1280, heightPx: 720, scale: 1, nodes: [] },
        sourceId: 'e1',
      })),
    }
  })

  it('lands 3 host-authored pages and unlocks scratch-build afterwards', async () => {
    const path = '/tmp/blank-land.pptx'
    const skill = createSlidesSkill(access, path)
    const r = await skill.executeTool!(
      tool('land_pages', {
        pages: [pageSpec('Cover'), pageSpec('Agenda'), pageSpec('Thanks')],
        insert_mode: 'replace',
      }),
    )
    expect(r.isError).toBeUndefined()
    expect(r.mutated).toBe(true)
    expect(getWebSession()?.opened.deck.slides.length).toBe(3)
    expect(deckTexts().join('\n')).toMatch(/Cover/)
    expect(deckTexts().join('\n')).toMatch(/Agenda/)
    expect(deckTexts().join('\n')).toMatch(/Thanks/)

    const add = await createSlidesSkill(access, path).executeTool!(
      tool('add_text_box', {
        slideIndex: 0,
        paragraphs: [{ runs: [{ text: 'x' }] }],
        x: 10,
        y: 10,
        w: 100,
        h: 50,
      }),
    )
    expect(add.isError).toBeUndefined()
    expect(String(add.output)).not.toMatch(/blockScratchBuild|Use cloud generation|from-scratch/)
  })

  it('rejects an empty pages array without landing', async () => {
    const before = getWebSession()?.opened.deck.slides.length
    const r = await createSlidesSkill(access, '/tmp/empty-land.pptx').executeTool!(
      tool('land_pages', { pages: [] }),
    )
    expect(r.isError).toBe(true)
    expect(String(r.output)).toContain('land_pages requires a non-empty pages array')
    expect(getWebSession()?.opened.deck.slides.length).toBe(before)
  })

  it('rejects an invalid spec and leaves the blank deck unchanged', async () => {
    const before = getWebSession()?.opened.deck.slides.length
    const r = await createSlidesSkill(access, '/tmp/bad-land.pptx').executeTool!(
      tool('land_pages', { pages: [{}] }),
    )
    expect(r.isError).toBe(true)
    expect(String(r.output)).toContain('invalid page spec:')
    expect(getWebSession()?.opened.deck.slides.length).toBe(before)
  })

  it('parses the whole batch before landing so a later bad page does not half-land', async () => {
    const before = getWebSession()?.opened.deck.slides.length
    const r = await createSlidesSkill(access, '/tmp/half-land.pptx').executeTool!(
      tool('land_pages', {
        pages: [pageSpec('Keep me'), {}, pageSpec('Also good')],
      }),
    )
    expect(r.isError).toBe(true)
    expect(String(r.output)).toContain('invalid page spec:')
    expect(getWebSession()?.opened.deck.slides.length).toBe(before)
    expect(deckTexts().join('\n')).not.toMatch(/Keep me/)
  })

  it('replace_at swaps page 0 in place', async () => {
    const path = '/tmp/replace-at.pptx'
    const skill = createSlidesSkill(access, path)
    await skill.executeTool!(
      tool('land_pages', { pages: [pageSpec('Old title'), pageSpec('Kept')], insert_mode: 'replace' }),
    )
    const r = await skill.executeTool!(
      tool('land_pages', {
        pages: [pageSpec('New title')],
        insert_mode: 'replace_at',
        at_index: 0,
      }),
    )
    expect(r.isError).toBeUndefined()
    expect(getWebSession()?.opened.deck.slides.length).toBe(2)
    const texts = deckTexts().join('\n')
    expect(texts).toMatch(/New title/)
    expect(texts).toMatch(/Kept/)
    expect(texts).not.toMatch(/Old title/)
  })

  it('append adds a page and keeps the old text', async () => {
    const path = '/tmp/append.pptx'
    const skill = createSlidesSkill(access, path)
    await skill.executeTool!(tool('land_pages', { pages: [pageSpec('First')], insert_mode: 'replace' }))
    const r = await skill.executeTool!(
      tool('land_pages', { pages: [pageSpec('Second')], insert_mode: 'append' }),
    )
    expect(r.isError).toBeUndefined()
    expect(getWebSession()?.opened.deck.slides.length).toBe(2)
    const texts = deckTexts().join('\n')
    expect(texts).toMatch(/First/)
    expect(texts).toMatch(/Second/)
  })
})

describe('control-mode generate/plan/regenerate guards', () => {
  const slide = { widthPx: 1280, heightPx: 720, scale: 1, nodes: [] } as unknown as RenderSlide

  beforeEach(() => {
    clearSkillStateCache()
  })

  it('topic-only generate_deck fails with pages_spec required and never plans', async () => {
    const planDeckOutline = vi.fn()
    const generatePageLocal = vi.fn()
    const access: DeckAccess = {
      hostAuthoredSpecsOnly: true,
      getSlides: () => [slide],
      getCurrent: () => 0,
      getSelectedIds: () => [],
      applySlide: () => {},
      applyDeck: () => {},
      fitWidthPx: 1280,
      planDeckOutline,
      generatePageLocal,
      generateFromHtml: vi.fn(async () => ({ ok: true, pages: 1 })),
    }
    const r = await createSlidesSkill(access, '/tmp/topic-only.pptx').executeTool!(
      tool('generate_deck', { topic: 'Q3 review', approx_pages: 3 }),
    )
    expect(r.isError).toBe(true)
    expect(String(r.output)).toBe('control mode requires pages_spec; use land_pages')
    expect(String(r.output)).not.toMatch(/web control mode has no local LLM/)
    expect(planDeckOutline).not.toHaveBeenCalled()
    expect(generatePageLocal).not.toHaveBeenCalled()
  })

  it('plan_deck in control mode fails with the same pages_spec string', async () => {
    const access: DeckAccess = {
      hostAuthoredSpecsOnly: true,
      getSlides: () => [slide],
      getCurrent: () => 0,
      getSelectedIds: () => [],
      applySlide: () => {},
      applyDeck: () => {},
      fitWidthPx: 1280,
    }
    const r = await createSlidesSkill(access).executeTool!(
      tool('plan_deck', {
        core_hook: 'h',
        style: 's',
        pages: [{ title: 'T', brief: 'b', layout: 'cover' }],
      }),
    )
    expect(r.isError).toBe(true)
    expect(String(r.output)).toBe('control mode requires pages_spec; use land_pages')
  })

  it('createControlDeckAccess does not call getAiSettings', async () => {
    const getAiSettings = vi.fn()
    vi.stubGlobal('window', { slidesApi: { getAiSettings } })
    const access = createControlDeckAccess({
      getSlides: () => [slide],
      getCurrent: () => 0,
      getSelectedIds: () => [],
      applySlide: () => {},
      applyDeck: () => {},
      fitWidthPx: 1280,
      askClarification: async () => ({ answers: '' }),
    })
    expect(access.hostAuthoredSpecsOnly).toBe(true)
    expect(access.generatePageLocal).toBeUndefined()
    expect(getAiSettings).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
