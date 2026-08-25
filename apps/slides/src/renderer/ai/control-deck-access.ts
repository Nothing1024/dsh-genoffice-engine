/**
 * Control-mode DeckAccess: host-authored PageSpec landing only (no iframe BYOK / gsk).
 * Planning LLMs live on the host; this adapter only lands markers via htmlToPptx.
 */
import type { RenderSlide } from '@genoffice/pptx-render'
import { landFromHtml, landReplaceAt } from './deck-landing'
import type { ClarifyQuestion, DeckAccess } from './slides-skill'

export function createControlDeckAccess(opts: {
  getSlides: () => RenderSlide[]
  getCurrent: () => number
  getSelectedIds: () => string[]
  applySlide: (slideIndex: number, updated: RenderSlide) => void
  applyDeck: (slides: RenderSlide[], goTo?: number) => void
  fitWidthPx: number
  askClarification: (questions: ClarifyQuestion[]) => Promise<{ answers: string; cancelled?: boolean }>
}): DeckAccess {
  return {
    hostAuthoredSpecsOnly: true,
    getSlides: opts.getSlides,
    getCurrent: opts.getCurrent,
    getSelectedIds: opts.getSelectedIds,
    applySlide: opts.applySlide,
    applyDeck: opts.applyDeck,
    fitWidthPx: opts.fitWidthPx,
    askClarification: opts.askClarification,
    isCloudPageGenEnabled: async () => false,
    generateFromHtml: async (pagesHtml, mode, deckName, insertAt) => {
      const res = await landFromHtml(pagesHtml, opts.fitWidthPx, mode, deckName, insertAt)
      if (!res.ok) return res
      opts.applyDeck(res.slides, res.insertedIndex ?? res.appendedFrom)
      return {
        ok: true,
        pages: res.pages,
        appendedFrom: res.appendedFrom,
        insertedIndex: res.insertedIndex,
        fallbackReason: res.fallbackReason,
        imageFailures: res.imageFailures,
      }
    },
    regenerateSlide: async (slideIndex, html) => {
      const res = await landReplaceAt(html, opts.fitWidthPx, slideIndex)
      if (!res.ok) return res
      opts.applyDeck(res.slides, slideIndex)
      return { ok: true, imageFailures: res.imageFailures }
    },
    searchImages: async (query, maxResults) => {
      try {
        const r = await window.slidesApi.imageSearch(query, maxResults)
        return r.images.map((im) => im.imageUrl).filter(Boolean)
      } catch {
        return []
      }
    },
    saveSidecar: async (data) => {
      try {
        await window.slidesApi.saveStyleSidecar(data)
      } catch {
        /* fail-open */
      }
    },
    saveStyleTemplate: async (name, data) => {
      try {
        return await window.slidesApi.saveStyleTemplate(name, data)
      } catch {
        return { ok: false, error: String('') }
      }
    },
    listStyleTemplates: async () => {
      try {
        return await window.slidesApi.listStyleTemplates()
      } catch {
        return []
      }
    },
    loadStyleTemplate: async (name) => {
      try {
        return await window.slidesApi.loadStyleTemplate(name)
      } catch {
        return { ok: false, error: String('') }
      }
    },
    gskTools: () => false,
  }
}
