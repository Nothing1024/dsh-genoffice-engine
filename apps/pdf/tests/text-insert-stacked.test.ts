import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { applyTextInserts, verifyTextEdits } from '../src/main/text-edit'
import type { TextInsertInput } from '../src/shared/ipc'

async function blankPage(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([595, 842])
  return doc.save({ useObjectStreams: false })
}

const insert = (text: string): TextInsertInput => ({
  pageIndex: 0,
  origin: [60, 500],
  text,
  fontSize: 16,
  color: [0, 0, 0],
})

describe('runs inserted on the same spot', () => {
  it('verifies clean past the depth where pdfium stops extracting them', async () => {
    // An agent (or a user) that keeps inserting at the default position stacks runs on
    // one origin. pdfium's text page then treats the later objects as duplicates of the
    // ink it already collected and extracts nothing for them — the save-time read-back
    // used to read that as "the replacement is missing" and refuse to write the file,
    // leaving the document unsaveable.
    let bytes = await blankPage()
    for (let i = 0; i < 7; i++) {
      const text = `Stacked run ${i}`
      const applied = await applyTextInserts(bytes, [insert(text)])
      expect(applied.skipped).toEqual([])
      bytes = applied.bytes
      expect(await verifyTextEdits(bytes, [{ pageIndex: 0, newText: text }])).toEqual([])
    }
  })

  it('still reports text that never made it into the page', async () => {
    const bytes = await blankPage()
    const failures = await verifyTextEdits(bytes, [{ pageIndex: 0, newText: 'never drawn' }])
    expect(failures).toHaveLength(1)
    expect(failures[0]!.reason).toContain('missing from saved output')
  })
})
