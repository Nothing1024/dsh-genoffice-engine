/**
 * Shared placeholder panel for tabs whose real implementation lands in a
 * later task (terminal Task 19, genoffice Task 12, files Task 16).
 */
import type { ReactNode } from 'react'

/**
 * Placeholder body.
 * @param label - the tab name shown in the placeholder copy.
 * @returns the placeholder element.
 */
export function PlaceholderPanel({ label }: { label: string }): ReactNode {
  return (
    <div style={{ padding: 16, color: 'var(--dsw-alias-label-dimmed)', fontSize: 13 }}>
      {label} 面板建设中…
    </div>
  )
}
