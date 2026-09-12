/**
 * Host for the PDF → Office conversion worker.
 * Cancel is cooperative: requestConvertCancel() aborts the in-flight job
 * and also latches a one-shot pre-cancel for the next start.
 */
import type { PdfConvertFormat } from '../shared/ipc'

export type ConvertOfficeBytes =
  | { canceled: true }
  | { canceled?: false; bytes: Uint8Array; scannedDocument: boolean; warnings: string[] }

type WorkerOut =
  | { type: 'progress'; page: number; total: number }
  | { type: 'done'; bytes: ArrayBuffer; scannedDocument: boolean; warnings: string[] }
  | { type: 'canceled' }
  | { type: 'error'; error: string }

let pendingAbort = false
let active: Worker | null = null

export function requestConvertCancel(): void {
  pendingAbort = true
  active?.postMessage({ type: 'cancel' })
}

export async function runConvertInWorker(
  pdf: Uint8Array,
  format: PdfConvertFormat,
  onProgress?: (page: number, total: number) => void,
): Promise<ConvertOfficeBytes> {
  if (pendingAbort) {
    pendingAbort = false
    return { canceled: true }
  }
  const worker = new Worker(new URL('./web-convert-office.worker.ts', import.meta.url), {
    type: 'module',
  })
  active = worker
  const copy = pdf.slice()
  try {
    return await new Promise<ConvertOfficeBytes>((resolve, reject) => {
      const finish = (fn: () => void) => {
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
        try {
          worker.terminate()
        } catch {
          /* ignore */
        }
        if (active === worker) active = null
        fn()
      }
      const onMessage = (ev: MessageEvent<WorkerOut>) => {
        const msg = ev.data
        if (msg.type === 'progress') {
          onProgress?.(msg.page, msg.total)
          return
        }
        if (msg.type === 'done') {
          pendingAbort = false
          finish(() =>
            resolve({
              bytes: new Uint8Array(msg.bytes),
              scannedDocument: msg.scannedDocument,
              warnings: msg.warnings,
            }),
          )
          return
        }
        if (msg.type === 'canceled') {
          pendingAbort = false
          finish(() => resolve({ canceled: true }))
          return
        }
        if (msg.type === 'error') {
          pendingAbort = false
          finish(() => reject(new Error(msg.error)))
        }
      }
      const onError = (err: ErrorEvent) => {
        pendingAbort = false
        finish(() => reject(new Error(err.message || 'convert worker failed')))
      }
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onError)
      worker.postMessage({ type: 'convert', format, pdf: copy.buffer }, [copy.buffer])
    })
  } catch (error) {
    if (active === worker) {
      try {
        worker.terminate()
      } catch {
        /* ignore */
      }
      active = null
    }
    throw error
  }
}
