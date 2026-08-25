/**
 * One LLM turn over `window.slidesApi.aiStream`, aggregating deltas.
 * Shared by AiPanel (desktop) and web control-mode DeckAccess.
 */
import { IPC_STREAM_SILENCE_TIMEOUT_MS } from '@genoffice/agent-core'
import type { AiSettings } from '../../shared/ipc'
import { t } from '../i18n/locale'
import type { LlmResult, RunLlmOnce } from './local-page-gen'

export const SLIDES_GEN_MODEL = 'claude-opus-4-7'

export function settingsForGen(cur: AiSettings): AiSettings {
  if (cur.provider !== 'anthropic') return cur
  const ap = cur.providers.anthropic
  return {
    ...cur,
    providers: { ...cur.providers, anthropic: { ...ap, model: SLIDES_GEN_MODEL } },
  }
}

export function createRunLlmOnce(getSettings: () => AiSettings): RunLlmOnce {
  const runLlmAttempt = (
    settings: AiSettings,
    system: string,
    user: string,
    timeoutMs: number,
    signal?: AbortSignal,
    maxTokens?: number,
  ): Promise<LlmResult> =>
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve({ ok: false, error: t('aiErrStopped'), errKind: 'stopped' })
        return
      }
      const requestId = crypto.randomUUID()
      let buf = ''
      let settled = false
      const finish = (r: LlmResult, cancelUpstream = false) => {
        if (settled) return
        settled = true
        clearTimeout(to)
        signal?.removeEventListener('abort', onAbort)
        unsub()
        if (cancelUpstream) void window.slidesApi.aiStreamCancel(requestId)
        resolve(r)
      }
      const onAbort = () =>
        finish({ ok: false, error: t('aiErrStopped'), errKind: 'stopped' }, true)
      let to: ReturnType<typeof setTimeout> | undefined
      const armTimeout = () => {
        clearTimeout(to)
        to = setTimeout(
          () =>
            finish(
              {
                ok: false,
                error: t('aiErrTimeout', { ms: timeoutMs }),
                errKind: 'timeout',
              },
              true,
            ),
          timeoutMs,
        )
      }
      armTimeout()
      const unsub = window.slidesApi.onAiStream((chunk) => {
        if (chunk.requestId !== requestId) return
        armTimeout()
        if (chunk.type === 'delta') buf += chunk.text ?? ''
        else if (chunk.type === 'done')
          finish(
            buf.trim()
              ? { ok: true, text: buf }
              : { ok: false, text: buf, error: t('aiErrEmptyOutput'), errKind: 'empty' },
          )
        else if (chunk.type === 'error')
          finish({
            ok: false,
            error: chunk.error ?? t('aiErrUnknown'),
            ...(chunk.error?.includes('(empty stream)') ? { errKind: 'empty' as const } : {}),
          })
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      window.slidesApi
        .aiStream({
          requestId,
          settings,
          system,
          messages: [{ role: 'user', text: user }],
          ...(maxTokens ? { maxTokens } : {}),
        })
        .catch((e) =>
          finish({
            ok: false,
            error: t('aiErrRequestFailed', {
              msg: e instanceof Error ? e.message : String(e),
            }),
          }),
        )
    })

  return async (
    system,
    user,
    timeoutMs = IPC_STREAM_SILENCE_TIMEOUT_MS,
    useGenModel = true,
    signal,
    maxTokens,
  ) => {
    const cur = getSettings()
    const first = await runLlmAttempt(
      useGenModel ? settingsForGen(cur) : cur,
      system,
      user,
      timeoutMs,
      signal,
      maxTokens,
    )
    if (first.ok || !useGenModel || signal?.aborted) return first
    if (first.errKind) return first
    if (cur.provider !== 'anthropic') return first
    if (cur.providers.anthropic?.model === SLIDES_GEN_MODEL) return first
    return runLlmAttempt(cur, system, user, timeoutMs, signal, maxTokens)
  }
}
