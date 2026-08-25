/**
 * Browser landing: spec JSON → one-slide pptx bytes → cloudpptx: marker →
 * webHtmlToPptx (replace / append / replace_at). No Electron, no gsk.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { openPptx, savePptx, type TextElement } from '@genoffice/pptx-engine'
import { parsePageSpec, buildPagePptx } from '../src/shared/page-spec'
import {
  clearIssuedCloudPages,
  issueCloudPage,
} from '../src/shared/cloud-page-marker'
import {
  getWebSession,
  webHtmlToPptx,
  webNewBlank,
} from '../src/renderer/web-slides-session'

const noImages = { fetchImage: async () => null }

async function pageMarker(text: string): Promise<string> {
  const parsed = parsePageSpec(
    JSON.stringify({
      background: '#16395C',
      elements: [
        {
          type: 'text',
          x: 80,
          y: 60,
          w: 800,
          h: 90,
          paragraphs: [{ runs: [{ text, sizePt: 24 }] }],
        },
      ],
    }),
  )
  if (!parsed.ok) throw new Error(parsed.error)
  const { bytes } = await buildPagePptx(parsed.spec, noImages)
  return issueCloudPage(bytes, `t-${text}`)
}

function slideTexts(res: { slides: Array<{ nodes: unknown[] }> } | { error: string }): string[] {
  if ('error' in res) throw new Error(res.error)
  return res.slides.map((_, i) => {
    const session = getWebSession()
    const slide = session?.opened.deck.slides[i]
    const texts = (slide?.elements ?? []).filter((e): e is TextElement => e.type === 'text')
    return texts.flatMap((el) => el.text?.paragraphs.flatMap((p) => p.runs.map((r) => r.text)) ?? []).join('')
  })
}

describe('webHtmlToPptx marker landing', () => {
  beforeEach(() => {
    clearIssuedCloudPages()
  })

  it('replace assembles several markers into one deck', async () => {
    const markers = await Promise.all([pageMarker('one'), pageMarker('two'), pageMarker('three')])
    const res = await webHtmlToPptx(markers, 1280, 'replace')
    expect('error' in res).toBe(false)
    if ('error' in res) return
    expect(res.slides).toHaveLength(3)
    expect(slideTexts(res)).toEqual(['one', 'two', 'three'])
    const session = getWebSession()
    expect(session).not.toBeNull()
    const reopened = await openPptx(await savePptx(session!.opened))
    expect(reopened.deck.slides).toHaveLength(3)
  })

  it('append merges onto the current web session', async () => {
    await webNewBlank(1280)
    const marker = await pageMarker('appended')
    const res = await webHtmlToPptx([marker], 1280, 'append')
    expect('error' in res).toBe(false)
    if ('error' in res) return
    expect(res.appendedFrom).toBe(1)
    expect(res.slides.length).toBeGreaterThanOrEqual(2)
    expect(slideTexts(res).includes('appended')).toBe(true)
  })

  it('replace_at swaps one page in place', async () => {
    const markers = await Promise.all([pageMarker('a'), pageMarker('b'), pageMarker('c')])
    const first = await webHtmlToPptx(markers, 1280, 'replace')
    expect('error' in first).toBe(false)
    const replacement = await pageMarker('B2')
    const res = await webHtmlToPptx([replacement], 1280, 'replace_at', 1)
    expect('error' in res).toBe(false)
    if ('error' in res) return
    expect(res.replacedIndex).toBe(1)
    expect(slideTexts(res)).toEqual(['a', 'B2', 'c'])
  })

  it('rejects unknown markers', async () => {
    const res = await webHtmlToPptx(['cloudpptx:/nope.pptx'], 1280, 'replace')
    expect('error' in res).toBe(true)
    if ('error' in res) expect(res.error).toMatch(/unknown cloud page marker/)
  })
})
