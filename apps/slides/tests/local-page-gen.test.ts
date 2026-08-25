import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generatePageLocalWithLlm } from '../src/renderer/ai/local-page-gen'
import { createControlDeckAccess } from '../src/renderer/ai/control-deck-access'
import type { RenderSlide } from '@genoffice/pptx-render'
import type { RunLlmOnce } from '../src/renderer/ai/local-page-gen'

const args = {
  pageIndex: 1,
  totalPages: 3,
  coreHook: 'hook',
  style: 'dark navy',
  title: 'Hello',
  brief: 'Say hello',
  layout: 'cover_typography_hero',
  images: [] as string[],
  canvasW: 1280,
  canvasH: 720,
}

describe('generatePageLocalWithLlm', () => {
  const original = globalThis.window

  beforeEach(() => {
    vi.stubGlobal('window', {
      slidesApi: {
        localGeneratePage: vi.fn(),
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (original) vi.stubGlobal('window', original)
  })

  it('retries once when the first spec is rejected then returns the marker', async () => {
    const runLlmOnce: RunLlmOnce = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: 'not-json' })
      .mockResolvedValueOnce({ ok: true, text: '{"elements":[]}' })
    const localGeneratePage = window.slidesApi.localGeneratePage as ReturnType<typeof vi.fn>
    localGeneratePage
      .mockResolvedValueOnce({ ok: false, error: 'no valid elements' })
      .mockResolvedValueOnce({ ok: true, marker: 'cloudpptx:abc' })

    const res = await generatePageLocalWithLlm(args, runLlmOnce, 'empty', 'unknown')
    expect(res).toEqual({ ok: true, marker: 'cloudpptx:abc' })
    expect(runLlmOnce).toHaveBeenCalledTimes(2)
    const secondUser = (runLlmOnce as ReturnType<typeof vi.fn>).mock.calls[1][1] as string
    expect(secondUser).toContain('no valid elements')
  })
})

describe('createControlDeckAccess', () => {
  const original = globalThis.window
  const slide = { widthPx: 1280, heightPx: 720, scale: 1, nodes: [] } as unknown as RenderSlide

  afterEach(() => {
    vi.unstubAllGlobals()
    if (original) vi.stubGlobal('window', original)
  })

  it('is host-authored landing only: no BYOK LLM, cloud stays off', async () => {
    const getAiSettings = vi.fn()
    vi.stubGlobal('window', {
      slidesApi: {
        getAiSettings,
        htmlToPptx: vi.fn(),
      },
    })
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
    expect(access.generateStyleSkill).toBeUndefined()
    expect(access.planDeckOutline).toBeUndefined()
    expect(await access.isCloudPageGenEnabled?.()).toBe(false)
    expect(getAiSettings).not.toHaveBeenCalled()
  })
})
