/**
 * Cloud/local single-page pptx markers (`cloudpptx:<id>`). Desktop writes a
 * temp file and records the path; the web renderer keeps bytes in memory
 * under the same prefix so `htmlToPptx` can land pages without IPC.
 */
export const CLOUD_PAGE_PREFIX = 'cloudpptx:'

const issuedPages = new Map<string, Uint8Array>()

export function issueCloudPage(bytes: Uint8Array, id: string): string {
  issuedPages.set(id, bytes)
  return CLOUD_PAGE_PREFIX + id
}

export function readIssuedCloudPage(marker: string): Uint8Array | null {
  if (!marker.startsWith(CLOUD_PAGE_PREFIX)) return null
  return issuedPages.get(marker.slice(CLOUD_PAGE_PREFIX.length)) ?? null
}

export function hasIssuedCloudPage(marker: string): boolean {
  if (!marker.startsWith(CLOUD_PAGE_PREFIX)) return false
  return issuedPages.has(marker.slice(CLOUD_PAGE_PREFIX.length))
}

/** Test helper — drop in-memory pages so cases don't leak across runs. */
export function clearIssuedCloudPages(): void {
  issuedPages.clear()
}
