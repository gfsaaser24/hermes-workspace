import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatStreamEvent } from '@/stores/chat-store'
import { useChatStore } from '@/stores/chat-store'

/**
 * hermes-jcmm: re-attach the chat UI to a run that is still executing on the
 * server.
 *
 * Reloading, switching tabs, or losing the SSE socket used to leave the user
 * with a bare spinner: the agent kept working but nothing reached the browser.
 * On load / focus / visibility change this hook asks the server whether the
 * session has an active run and, if so, opens
 * GET /api/runs/{sessionKey}/{runId}/stream — which replays everything that
 * already happened (tool cards, thinking, assistant text) and then tails the
 * live run until it completes.
 */

/** Mirrors RESUMABLE_RUN_STATUSES in src/server/run-resume.ts. */
const RESUMABLE_RUN_STATUSES: ReadonlySet<string> = new Set([
  'accepted',
  'active',
  'handoff',
  'stalled',
])

export type ResumeOutcome = 'open' | 'done' | 'error' | 'stalled'

/** How long to wait before re-attaching to a run the server called stalled. */
export const RESUME_RETRY_MS = 30_000

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Feed one resume SSE event into the chat store. Exported so the hydrate
 * logic can be unit-tested without a DOM or a live stream.
 */
export function applyResumeEvent({
  event,
  data,
  sessionKey,
  processEvent,
}: {
  event: string
  data: Record<string, unknown>
  sessionKey: string
  processEvent: (event: ChatStreamEvent) => void
}): ResumeOutcome {
  const runId = readString(data.runId) || undefined

  switch (event) {
    case 'started':
      // Seed an empty streaming row so the UI shows "working" immediately,
      // even before any replayed text lands.
      processEvent({
        type: 'chunk',
        text: '',
        fullReplace: true,
        runId,
        sessionKey,
        transport: 'send-stream',
      })
      return 'open'

    case 'chunk': {
      const text = readString(data.text)
      if (!text) return 'open'
      processEvent({
        type: 'chunk',
        text,
        // The resume stream always sends the accumulated text.
        fullReplace: true,
        runId,
        sessionKey,
        transport: 'send-stream',
      })
      return 'open'
    }

    case 'thinking': {
      const text = readString(data.text)
      if (!text) return 'open'
      processEvent({
        type: 'thinking',
        text,
        runId,
        sessionKey,
        transport: 'send-stream',
      })
      return 'open'
    }

    case 'tool': {
      processEvent({
        type: 'tool',
        phase: readString(data.phase) || 'calling',
        name: readString(data.name) || 'tool',
        toolCallId: readString(data.toolCallId) || undefined,
        args: data.args,
        preview: readString(data.preview) || undefined,
        result: readString(data.result) || undefined,
        runId,
        sessionKey,
        transport: 'send-stream',
      })
      return 'open'
    }

    case 'artifact': {
      const kind = readString(data.kind) || 'artifact'
      const title = readString(data.title) || 'Artifact created'
      const path = readString(data.path)
      processEvent({
        type: 'tool',
        phase: 'complete',
        name: `artifact:${kind}`,
        result: path ? `${title} — ${path}` : title,
        args: { title, kind, path: path || undefined },
        runId,
        sessionKey,
        transport: 'send-stream',
      })
      return 'open'
    }

    case 'done': {
      const state = readString(data.state) || 'complete'
      // hermes-jcmm: 'stalled' is a guess, not an answer. Finalising here
      // would turn half-written text into a completed reply. Leave the
      // streaming row alone and let the caller re-attach.
      if (state === 'stalled') return 'stalled'
      processEvent({
        type: 'done',
        state,
        errorMessage: readString(data.errorMessage) || undefined,
        message: data.message as Extract<
          ChatStreamEvent,
          { type: 'done' }
        >['message'],
        runId,
        sessionKey,
        transport: 'send-stream',
      })
      return state === 'error' ? 'error' : 'done'
    }

    case 'error':
      return 'error'

    default:
      // heartbeat / unknown — just proof of life.
      return 'open'
  }
}

/**
 * Explicitly stop a run. Browser disconnects intentionally leave the agent
 * running, so the Stop button has to say so out loud.
 */
export async function requestRunStop(
  sessionKey: string,
  runId: string,
): Promise<boolean> {
  if (!sessionKey || !runId) return false
  try {
    const response = await fetch(
      `/api/runs/${encodeURIComponent(sessionKey)}/${encodeURIComponent(runId)}/abandon`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    )
    if (!response.ok) return false
    const data = (await response.json()) as { ok?: boolean }
    return data.ok === true
  } catch {
    return false
  }
}

type ActiveRunResponse = {
  ok?: boolean
  run?: { runId?: string; status?: string; sessionKey?: string } | null
}

export function useRunResume({
  sessionKey,
  enabled,
  isLocalStreamActive,
  onRunComplete,
}: {
  sessionKey: string
  enabled: boolean
  isLocalStreamActive: boolean
  onRunComplete?: () => void
}): {
  resumedRunId: string | null
  resumeStalled: boolean
  stopResumedRun: () => void
} {
  const [resumedRunId, setResumedRunId] = useState<string | null>(null)
  const [resumeStalled, setResumeStalled] = useState(false)

  const sessionKeyRef = useRef(sessionKey)
  sessionKeyRef.current = sessionKey
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const localStreamRef = useRef(isLocalStreamActive)
  localStreamRef.current = isLocalStreamActive
  const onRunCompleteRef = useRef(onRunComplete)
  onRunCompleteRef.current = onRunComplete
  const attachedRunIdRef = useRef<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
  }, [])

  const detach = useCallback(() => {
    clearRetry()
    attachedRunIdRef.current = null
    if (controllerRef.current) {
      controllerRef.current.abort()
      controllerRef.current = null
    }
    setResumedRunId(null)
    setResumeStalled(false)
  }, [clearRetry])

  const checkRef = useRef<() => void>(() => undefined)

  const attach = useCallback(async (key: string, runId: string) => {
    if (attachedRunIdRef.current) return
    attachedRunIdRef.current = runId
    const controller = new AbortController()
    controllerRef.current = controller
    setResumedRunId(runId)
    setResumeStalled(false)

    const store = useChatStore.getState()
    store.setSessionWaiting(key, runId)

    let outcome: ResumeOutcome = 'open'
    try {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(key)}/${encodeURIComponent(runId)}/stream`,
        { signal: controller.signal },
      )
      if (!response.ok || !response.body) {
        throw new Error(`resume stream ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime safety
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''
        for (const block of blocks) {
          if (!block.trim() || block.startsWith(':')) continue
          let eventName = ''
          let raw = ''
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) eventName = line.slice(7).trim()
            else if (line.startsWith('data: ')) raw += line.slice(6)
            else if (line.startsWith('data:')) raw += line.slice(5)
          }
          if (!eventName || !raw) continue
          let parsed: Record<string, unknown>
          try {
            parsed = JSON.parse(raw) as Record<string, unknown>
          } catch {
            continue
          }
          outcome = applyResumeEvent({
            event: eventName,
            data: parsed,
            sessionKey: key,
            processEvent: useChatStore.getState().processEvent,
          })
          if (outcome !== 'open') break
        }
        if (outcome !== 'open') break
      }
      // Stop reading; the server may still be holding the socket open.
      controller.abort()

      if (outcome === 'stalled') {
        // The server lost sight of the run but never said it finished. Hold
        // the waiting state and the banner, and try again shortly.
        if (controllerRef.current === controller) {
          setResumeStalled(true)
          clearRetry()
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null
            checkRef.current()
          }, RESUME_RETRY_MS)
        }
        return
      }
      if (controllerRef.current === controller) {
        useChatStore.getState().clearSessionWaiting(key)
        onRunCompleteRef.current?.()
      }
    } catch {
      // Network error — drop the waiting state so the UI never sits on a dead
      // spinner. Never touch it after an abort or a session switch: that run
      // (and another session's state) is not ours to clear.
      if (!controller.signal.aborted && sessionKeyRef.current === key) {
        useChatStore.getState().clearSessionWaiting(key)
      }
    } finally {
      // Identity guard: a session switch may already have started a new
      // attachment, and clearing these outside the guard clobbered it.
      if (controllerRef.current === controller) {
        controllerRef.current = null
        attachedRunIdRef.current = null
        if (outcome !== 'stalled') setResumedRunId(null)
      }
    }
  }, [clearRetry])

  const checkForActiveRun = useCallback(async () => {
    const key = sessionKeyRef.current
    if (!enabledRef.current || !key || key === 'new') return
    if (localStreamRef.current) return
    if (attachedRunIdRef.current) return

    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(key)}/active-run`,
      )
      if (!response.ok) return
      const data = (await response.json()) as ActiveRunResponse
      const run = data.run
      if (!run?.runId) return
      if (!RESUMABLE_RUN_STATUSES.has(run.status ?? '')) return
      // Re-check: a local send-stream may have started during the await.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- refs mutate across the await
      if (localStreamRef.current || attachedRunIdRef.current) return
      void attach(key, run.runId)
    } catch {
      // ignore — a focus event will retry
    }
  }, [attach])

  checkRef.current = () => {
    void checkForActiveRun()
  }

  useEffect(() => {
    detach()
    if (!enabled || !sessionKey || sessionKey === 'new') return
    void checkForActiveRun()
    // detach is stable; re-run whenever the session or enablement changes.
  }, [sessionKey, enabled, checkForActiveRun, detach])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onFocus = () => {
      void checkForActiveRun()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void checkForActiveRun()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [checkForActiveRun])

  useEffect(() => {
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      if (controllerRef.current) {
        controllerRef.current.abort()
        controllerRef.current = null
      }
      attachedRunIdRef.current = null
    }
  }, [])

  const stopResumedRun = useCallback(() => {
    const runId = attachedRunIdRef.current ?? resumedRunId
    const key = sessionKeyRef.current
    if (!runId || !key) return
    void requestRunStop(key, runId)
  }, [resumedRunId])

  return { resumedRunId, resumeStalled, stopResumedRun }
}
