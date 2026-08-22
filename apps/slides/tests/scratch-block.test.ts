/** Hard guard against "building from scratch by hand": calling add_text_box/add_shape/add_smartart on an empty deck should be refused and redirected to generate_deck. */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest'
import { createSlidesSkill, clearSkillStateCache, type DeckAccess } from '../src/renderer/ai/slides-skill'
import type { RenderSlide, PlacedBox, ShapeRenderNode } from '@genoffice/pptx-render'
import type { AgentToolCall } from '../src/shared/ipc'

const box = (x: number, y: number, w: number, h: number): PlacedBox => ({
  x,
  y,
  w,
  h,
  rotationDeg: 0,
  flipH: false,
  flipV: false,
  centerX: x + w / 2,
  centerY: y + h / 2,
})
const textNode = (id: string, text: string): ShapeRenderNode =>
  ({
    id,
    sourceId: id,
    type: 'shape',
    box: box(60, 60, 400, 80),
    fill: { kind: 'none' },
    text: {
      lines: [
        {
          runs: [
            {
              text,
              x: 0,
              baselineY: 20,
              fontFamily: 'Arial',
              fontSizePx: 24,
              color: '#000',
              bold: false,
              italic: false,
              underline: false,
              widthPx: 100,
            },
          ],
          top: 0,
          height: 28,
        },
      ],
      insets: { l: 0, t: 0, r: 0, b: 0 },
      anchor: 'top',
      fontScale: 1,
      contentHeight: 28,
    },
  }) as unknown as ShapeRenderNode

// Blank deck (1 empty page, no text content) -> from-scratch scenario
const blankDeck = { widthPx: 1280, heightPx: 720, nodes: [] } as unknown as RenderSlide
// Existing polished deck (multiple elements with text) -> refinement scenario
const richDeck = {
  widthPx: 1280,
  heightPx: 720,
  nodes: [
    textNode('a', 'Title'),
    textNode('b', 'Point 1'),
    textNode('c', 'Point 2'),
    textNode('d', 'Point 3'),
  ],
} as unknown as RenderSlide

function mkAccess(slides: RenderSlide[]): DeckAccess {
  return {
    getSlides: () => slides,
    getCurrent: () => 0,
    getSelectedIds: () => [],
    applySlide: () => {},
    applyDeck: () => {},
    fitWidthPx: 1280,
    generateFromHtml: async () => ({ ok: true, pages: 1 }),
  } as unknown as DeckAccess
}
const call = (name: string): AgentToolCall => ({
  id: 't',
  name,
  input: {
    slideIndex: 0,
    paragraphs: [{ runs: [{ text: 'x' }] }],
    kind: 'rect',
    x: 10,
    y: 10,
    w: 100,
    h: 50,
    layout: 'list',
    items: ['a'],
  },
})

let addElementSpy: MockedFunction<() => Promise<{ slide: RenderSlide; sourceId: string }>>

beforeEach(() => {
  clearSkillStateCache()
  addElementSpy = vi.fn(async () => ({ slide: blankDeck, sourceId: 'e1' }))
  ;(window as any).slidesApi = {
    addElement: addElementSpy,
    addSmartArt: vi.fn(async () => ({ slide: blankDeck, sourceId: 's1' })),
  }
})

describe('anti hand-building from scratch', () => {
  it('empty deck + add_text_box → refused with guidance toward generate_deck', async () => {
    const r = await createSlidesSkill(mkAccess([blankDeck])).executeTool!(call('add_text_box'))
    expect(r.isError).toBe(true)
    expect(r.output).toContain('generate_deck')
    expect((window as any).slidesApi.addElement).not.toHaveBeenCalled()
  })
  it('empty deck + add_shape → refused', async () => {
    const r = await createSlidesSkill(mkAccess([blankDeck])).executeTool!(call('add_shape'))
    expect(r.isError).toBe(true)
  })
  it('empty deck + add_smartart → refused', async () => {
    const r = await createSlidesSkill(mkAccess([blankDeck])).executeTool!(call('add_smartart'))
    expect(r.isError).toBe(true)
    expect((window as any).slidesApi.addSmartArt).not.toHaveBeenCalled()
  })
  it('existing rich deck (lots of content) + add_text_box → allowed (fine-tuning is legitimate)', async () => {
    const r = await createSlidesSkill(mkAccess([richDeck])).executeTool!(call('add_text_box'))
    expect(r.isError).toBeUndefined()
    expect((window as any).slidesApi.addElement).toHaveBeenCalledOnce()
  })
  it('after cloud generation has run, allowed even with an empty deck (tweak scenario)', async () => {
    const access = {
      ...mkAccess([blankDeck]),
      retryBackoffMs: 0,
      isCloudPageGenEnabled: async () => true,
      generatePageCloud: async () => ({ ok: true, marker: 'cloudpptx:/tmp/x.pptx' }),
    } as unknown as DeckAccess
    const skill = createSlidesSkill(access)
    // First run one generate_deck to set htmlGenerated=true
    await skill.executeTool!({
      id: 't',
      name: 'generate_deck',
      input: {
        core_hook: 'h',
        style: 's',
        pages: [{ title: 'T', brief: 'b', layout: 'data', image_queries: [] }],
      },
    })
    const r = await skill.executeTool!(call('add_text_box'))
    expect(r.isError).toBeUndefined()
  })
  it('state persists across createSlidesSkill instances when docPath matches (BR-015)', async () => {
    const docPath = '/tmp/test-state-persist.pptx'
    const access = {
      ...mkAccess([blankDeck]),
      retryBackoffMs: 0,
      isCloudPageGenEnabled: async () => true,
      generatePageCloud: async () => ({ ok: true, marker: 'cloudpptx:/tmp/x.pptx' }),
    } as unknown as DeckAccess

    // Call 1: generate_deck on skill instance A — sets htmlGenerated=true in cached state
    const skillA = createSlidesSkill(access, docPath)
    await skillA.executeTool!({
      id: 't',
      name: 'generate_deck',
      input: {
        core_hook: 'h',
        style: 's',
        pages: [{ title: 'T', brief: 'b', layout: 'data', image_queries: [] }],
      },
    })

    // Call 2: add_text_box on a NEW skill instance B (same docPath) — must see htmlGenerated=true
    const skillB = createSlidesSkill(mkAccess([blankDeck]), docPath)
    const r = await skillB.executeTool!(call('add_text_box'))
    expect(r.isError).toBeUndefined()
    expect(addElementSpy).toHaveBeenCalledOnce()
  })

  it('state does NOT persist across instances when docPath differs', async () => {
    const access = {
      ...mkAccess([blankDeck]),
      retryBackoffMs: 0,
      isCloudPageGenEnabled: async () => true,
      generatePageCloud: async () => ({ ok: true, marker: 'cloudpptx:/tmp/x.pptx' }),
    } as unknown as DeckAccess

    // generate_deck on path A
    const skillA = createSlidesSkill(access, '/tmp/doc-a.pptx')
    await skillA.executeTool!({
      id: 't',
      name: 'generate_deck',
      input: {
        core_hook: 'h',
        style: 's',
        pages: [{ title: 'T', brief: 'b', layout: 'data', image_queries: [] }],
      },
    })

    // add_text_box on path B — different doc, fresh state → guard fires
    const skillB = createSlidesSkill(mkAccess([blankDeck]), '/tmp/doc-b.pptx')
    const r = await skillB.executeTool!(call('add_text_box'))
    expect(r.isError).toBe(true)
    expect(r.output).toContain('generate_deck')
  })
})
