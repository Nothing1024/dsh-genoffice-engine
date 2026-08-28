/**
 * A formula written this session reached disk as an <f> with no <v>: the app
 * and Excel recalculated on open and looked right, while openpyxl data_only,
 * pandas and preview services read the cell as empty. The save now collects the
 * engine's on-screen result for every journaled formula cell.
 */
import { CellValueType } from '@univerjs/core'
import { describe, expect, it } from 'vitest'

import { createEditJournal, recordSetRangeValues } from '../src/renderer/edit-journal'
import { collectFormulaCachedValues } from '../src/renderer/univer-sync'
import type { LazyWorkbookState, UniverRuntime } from '../src/renderer/univer-state'

/** A Univer runtime whose cell matrix answers from a `row:column` map. */
function runtimeWith(sheets: Record<string, Record<string, unknown>>): UniverRuntime {
  return {
    univerAPI: {
      getActiveWorkbook: () => ({
        getSheetBySheetId: (sheetId: string) => {
          const cells = sheets[sheetId]
          if (!cells) return undefined
          return {
            getSheet: () => ({
              getCellMatrix: () => ({
                getValue: (row: number, column: number) => cells[`${row}:${column}`],
              }),
            }),
          }
        },
      }),
    },
  } as unknown as UniverRuntime
}

function stateWith(journal: ReturnType<typeof createEditJournal>): LazyWorkbookState {
  return { editJournal: journal } as unknown as LazyWorkbookState
}

describe('collectFormulaCachedValues', () => {
  it('reads the engine result for a formula written this session', () => {
    const journal = createEditJournal()
    recordSetRangeValues(journal, 'sheet-1', { 3: { 7: { f: '=SUM(H2:H3)' } } })
    const runtime = runtimeWith({ 'sheet-1': { '3:7': { f: '=SUM(H2:H3)', v: 333 } } })
    expect(collectFormulaCachedValues(runtime, stateWith(journal))).toEqual([
      { sheetId: 'sheet-1', row: 3, column: 7, value: 333 },
    ])
  })

  it('carries text results', () => {
    const journal = createEditJournal()
    recordSetRangeValues(journal, 'sheet-1', { 0: { 0: { f: '=A2&"!"' } } })
    const runtime = runtimeWith({ 'sheet-1': { '0:0': { v: 'ok!' } } })
    expect(collectFormulaCachedValues(runtime, stateWith(journal))).toEqual([
      { sheetId: 'sheet-1', row: 0, column: 0, value: 'ok!' },
    ])
  })

  it('restores booleans that Univer keeps as 0/1', () => {
    const journal = createEditJournal()
    recordSetRangeValues(journal, 'sheet-1', { 0: { 0: { f: '=B1>5' }, 1: { f: '=B1>50' } } })
    const runtime = runtimeWith({
      'sheet-1': {
        '0:0': { v: 1, t: CellValueType.BOOLEAN },
        '0:1': { v: 0, t: CellValueType.BOOLEAN },
      },
    })
    // Saved as a bare number these would read back as 1/0 rather than TRUE/FALSE.
    expect(collectFormulaCachedValues(runtime, stateWith(journal))).toEqual([
      { sheetId: 'sheet-1', row: 0, column: 0, value: true },
      { sheetId: 'sheet-1', row: 0, column: 1, value: false },
    ])
  })

  it('keeps a numeric 0 that is not a boolean', () => {
    const journal = createEditJournal()
    recordSetRangeValues(journal, 'sheet-1', { 0: { 0: { f: '=B1-B1' } } })
    const runtime = runtimeWith({ 'sheet-1': { '0:0': { v: 0, t: CellValueType.NUMBER } } })
    expect(collectFormulaCachedValues(runtime, stateWith(journal))).toEqual([
      { sheetId: 'sheet-1', row: 0, column: 0, value: 0 },
    ])
  })

  it('ignores literal edits — only formula cells get a cached value', () => {
    const journal = createEditJournal()
    recordSetRangeValues(journal, 'sheet-1', { 0: { 0: { v: 'plain' } } })
    const runtime = runtimeWith({ 'sheet-1': { '0:0': { v: 'plain' } } })
    expect(collectFormulaCachedValues(runtime, stateWith(journal))).toEqual([])
  })

  it('falls back to the journal when the streamed viewport evicted the cell', () => {
    const journal = createEditJournal()
    recordSetRangeValues(journal, 'sheet-1', { 9: { 0: { f: '=SUM(A1:A2)' } } })
    recordSetRangeValues(journal, 'sheet-1', { 9: { 0: { v: 12 } } })
    // The sheet is live but the cell is no longer in the matrix.
    expect(collectFormulaCachedValues(runtimeWith({ 'sheet-1': {} }), stateWith(journal))).toEqual([
      { sheetId: 'sheet-1', row: 9, column: 0, value: 12 },
    ])
    // No runtime at all (recovery write-back) still uses the journal.
    expect(collectFormulaCachedValues(null, stateWith(journal))).toEqual([
      { sheetId: 'sheet-1', row: 9, column: 0, value: 12 },
    ])
  })

  it('skips a formula with no result anywhere rather than clearing a good <v>', () => {
    const journal = createEditJournal()
    recordSetRangeValues(journal, 'sheet-1', { 0: { 0: { f: '=SUM(A1:A2)' } } })
    expect(collectFormulaCachedValues(runtimeWith({ 'sheet-1': {} }), stateWith(journal))).toEqual(
      [],
    )
  })

  it('skips sheets deleted after the edit', () => {
    const journal = createEditJournal()
    recordSetRangeValues(journal, 'sheet-1', { 0: { 0: { f: '=SUM(A1:A2)' } } })
    journal.sheets.removed.add('sheet-1')
    const runtime = runtimeWith({ 'sheet-1': { '0:0': { v: 3 } } })
    expect(collectFormulaCachedValues(runtime, stateWith(journal))).toEqual([])
  })
})
