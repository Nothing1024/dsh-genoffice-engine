/**
 * Control-mode generate_deck without cloud: generatePageLocal builds a real
 * one-slide pptx (parsePageSpec + buildPagePptx), htmlToPptx lands markers
 * into the web session, htmlGenerated unlocks native add_text_box.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createSlidesSkill, clearSkillStateCache, type DeckAccess } from '../src/renderer/ai/slides-skill'
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

describe('web generate_deck local landing', () => {
  beforeEach(async () => {
    clearSkillStateCache()
    clearIssuedCloudPages()
    await webNewBlank(1280)
    ;(window as { slidesApi?: unknown }).slidesApi = {
      addElement: vi.fn(async () => ({
        slide: { widthPx: 1280, heightPx: 720, scale: 1, nodes: [] },
        sourceId: 'e1',
      })),
    }
  })

  it('lands ≥3 text pages locally and unlocks scratch-build afterwards', async () => {
    const applyDeck = (slides: RenderSlide[]) => {
      /* render tree is rebuilt from the web session; skill only needs applyDeck to exist */
      void slides
    }
    const access: DeckAccess = {
      getSlides: () => getWebSession() ? [{ widthPx: 1280, heightPx: 720, scale: 1, nodes: [] } as unknown as RenderSlide] : [],
      getCurrent: () => 0,
      getSelectedIds: () => [],
      applySlide: () => {},
      applyDeck,
      fitWidthPx: 1280,
      retryBackoffMs: 0,
      isCloudPageGenEnabled: async () => false,
      generatePageLocal: async (args) => {
        const specJson = JSON.stringify({
          background: '#16395C',
          elements: [
            {
              type: 'text',
              x: 80,
              y: 60,
              w: 800,
              h: 90,
              paragraphs: [{ runs: [{ text: args.title || `page ${args.pageIndex}`, sizePt: 24 }] }],
            },
          ],
        })
        const parsed = parsePageSpec(specJson)
        if (!parsed.ok) return { ok: false, error: parsed.error }
        const { bytes, imageFailures } = await buildPagePptx(parsed.spec, noImages)
        return {
          ok: true,
          marker: issueCloudPage(bytes, `p${args.pageIndex}`),
          ...(imageFailures.length ? { imageFailures } : {}),
        }
      },
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
    }

    const path = '/tmp/blank-control.pptx'
    const skill = createSlidesSkill(access, path)
    const call: AgentToolCall = {
      id: 't',
      name: 'generate_deck',
      input: {
        core_hook: 'hello',
        style: 'navy',
        pages: [
          { title: 'Cover', brief: 'hello', layout: 'cover_typography_hero' },
          { title: 'Agenda', brief: 'points', layout: 'three_column_cards' },
          { title: 'Thanks', brief: 'end', layout: 'closing_thank_you' },
        ],
      },
    }
    const r = await skill.executeTool!(call)
    expect(r.isError).toBeUndefined()

    const session = getWebSession()
    expect(session?.opened.deck.slides.length).toBeGreaterThanOrEqual(3)
    const texts = session!.opened.deck.slides.flatMap((s) =>
      s.elements.filter((e): e is TextElement => e.type === 'text'),
    )
    expect(texts.length).toBeGreaterThanOrEqual(3)
    expect(texts.every((el) => el.text?.paragraphs.some((p) => p.runs.some((run) => run.text.trim())))).toBe(
      true,
    )

    const next = createSlidesSkill(
      {
        ...access,
        getSlides: () => [
          { widthPx: 1280, heightPx: 720, scale: 1, nodes: [] } as unknown as RenderSlide,
        ],
      },
      path,
    )
    const add = await next.executeTool!({
      id: 't2',
      name: 'add_text_box',
      input: {
        slideIndex: 0,
        paragraphs: [{ runs: [{ text: 'x' }] }],
        x: 10,
        y: 10,
        w: 100,
        h: 50,
      },
    })
    expect(add.isError).toBeUndefined()
    expect(String(add.output)).not.toMatch(/blockScratchBuild|Use cloud generation/)
  })
})
