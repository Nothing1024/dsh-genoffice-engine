/**
 * Shared generateFromHtml / regenerateSlide landing over `window.slidesApi.htmlToPptx`.
 * Control mode and AiPanel both apply the returned deck; AiPanel additionally
 * tracks QC page ranges around the call.
 */
import type { RenderSlide } from '@genoffice/pptx-render'
import type { OpenResult } from '../../shared/ipc'
import { t } from '../i18n/locale'

export type LandedDeck = {
  ok: true
  pages: number
  appendedFrom: number
  insertedIndex?: number
  fallbackReason?: string
  imageFailures?: { page: number; url: string }[]
  slides: RenderSlide[]
  path?: string
  replacedIndex?: number
}

export type LandFailed = { ok: false; error: string }

type HtmlToPptxOk = OpenResult & {
  appendedFrom?: number
  replacedIndex?: number
  insertedIndex?: number
  fallbackReason?: string
  imageFailures?: { page: number; url: string }[]
}

function isLanded(res: unknown): res is HtmlToPptxOk {
  return (
    !!res &&
    typeof res === 'object' &&
    'slides' in res &&
    Array.isArray((res as HtmlToPptxOk).slides)
  )
}

function landError(res: unknown, fallback: string): LandFailed {
  if (res && typeof res === 'object' && 'error' in res && typeof res.error === 'string') {
    return { ok: false, error: res.error }
  }
  return { ok: false, error: fallback }
}

export async function landFromHtml(
  pagesHtml: string[],
  fitWidthPx: number,
  mode?: 'replace' | 'append' | 'insert_at',
  deckName?: string,
  insertAt?: number,
): Promise<LandedDeck | LandFailed> {
  try {
    const res = await window.slidesApi.htmlToPptx(
      pagesHtml,
      fitWidthPx,
      mode,
      insertAt,
      deckName,
    )
    if (!isLanded(res)) return landError(res, t('aiErrGenerateFailed'))
    return {
      ok: true,
      pages: res.slides.length,
      appendedFrom: typeof res.appendedFrom === 'number' ? res.appendedFrom : 0,
      insertedIndex: typeof res.insertedIndex === 'number' ? res.insertedIndex : undefined,
      fallbackReason: typeof res.fallbackReason === 'string' ? res.fallbackReason : undefined,
      imageFailures: Array.isArray(res.imageFailures) ? res.imageFailures : undefined,
      slides: res.slides,
      path: res.path,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function landReplaceAt(
  html: string,
  fitWidthPx: number,
  slideIndex: number,
): Promise<LandedDeck | LandFailed> {
  try {
    const res = await window.slidesApi.htmlToPptx([html], fitWidthPx, 'replace_at', slideIndex)
    if (!isLanded(res)) return landError(res, t('aiErrRegenFailed'))
    return {
      ok: true,
      pages: res.slides.length,
      appendedFrom: 0,
      insertedIndex: slideIndex,
      imageFailures: Array.isArray(res.imageFailures) ? res.imageFailures : undefined,
      slides: res.slides,
      path: res.path,
      replacedIndex: slideIndex,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
