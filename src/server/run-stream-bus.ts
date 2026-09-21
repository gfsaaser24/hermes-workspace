/**
 * hermes-jcmm: per-run fan-out of already-translated chat SSE events.
 *
 * The existing chat-event-bus deliberately DROPS every event whose runId is
 * registered in send-run-tracker — that dedup is what stops the browser from
 * rendering a message twice while /api/send-stream is attached. A browser that
 * reloaded mid-run needs exactly those dropped events, so resume traffic gets
 * its own bus with no dedup filter.
 *
 * In-memory only. The durable copy lives in run-store (disk); this bus is just
 * the live tail between "what is already persisted" and "what happens next".
 */

export type RunStreamEvent = {
  event: string
  data: Record<string, unknown>
}

type RunStreamSubscriber = (event: RunStreamEvent) => void

const BUS_KEY = '__hermes_run_stream_bus__' as const

/**
 * hermes-jcmm: how an explicit user Stop reaches the upstream agent fetch.
 * The browser disconnecting no longer aborts anything, so Stop needs a
 * deliberate handle on the run's AbortController.
 */
export type RunAbortHandle = {
  abort: () => void
  /** Agent-side run id for POST /v1/runs/{id}/stop, when we know one. */
  agentRunId?: string
}

type RunStreamBusState = {
  subscribers: Map<string, Set<RunStreamSubscriber>>
  aborts: Map<string, RunAbortHandle>
  /** Last terminal event per run, so a LATE subscriber still gets told. */
  terminal: Map<string, { event: RunStreamEvent; at: number }>
}

function getBus(): RunStreamBusState {
  const host = globalThis as Record<string, unknown>
  if (!host[BUS_KEY]) {
    host[BUS_KEY] = {
      subscribers: new Map<string, Set<RunStreamSubscriber>>(),
      aborts: new Map<string, RunAbortHandle>(),
      terminal: new Map<string, { event: RunStreamEvent; at: number }>(),
    } satisfies RunStreamBusState
  }
  return host[BUS_KEY] as RunStreamBusState
}

export function registerRunAbort(
  runId: string,
  handle: RunAbortHandle,
): void {
  if (!runId) return
  getBus().aborts.set(runId, handle)
}

export function unregisterRunAbort(runId: string): void {
  getBus().aborts.delete(runId)
}

export function getRunAbort(runId: string): RunAbortHandle | null {
  return getBus().aborts.get(runId) ?? null
}

/** Events worth mirroring to resumers. Keepalives are re-generated per stream. */
export const RESUME_PUBLISHED_EVENTS: ReadonlySet<string> = new Set([
  'started',
  'chunk',
  'thinking',
  'tool',
  'artifact',
  'step',
  'done',
  'error',
])

const TERMINAL_MEMO_TTL_MS = 10 * 60 * 1000

export function publishRunEvent(
  runId: string,
  event: string,
  data: Record<string, unknown>,
): void {
  if (!runId) return
  const bus = getBus()
  if (event === 'done' || event === 'error') {
    // Remember it even with zero subscribers — a tab that attaches a second
    // later must still be told the run is over instead of hanging on
    // keepalives.
    const now = Date.now()
    for (const [key, memo] of bus.terminal) {
      if (now - memo.at > TERMINAL_MEMO_TTL_MS) bus.terminal.delete(key)
    }
    // hermes-jcmm: a user Stop wins. The upstream abort that Stop triggers
    // also raises an 'error' terminal a few ms later; do not let it replace
    // the remembered done{state:'stopped'} a late subscriber should see.
    const prev = bus.terminal.get(runId)
    const prevStopped =
      prev?.event.event === 'done' &&
      (prev.event.data as { state?: unknown }).state === 'stopped'
    if (!prevStopped) {
      bus.terminal.set(runId, { event: { event, data }, at: now })
    }
  }
  const subscribers = bus.subscribers.get(runId)
  if (!subscribers || subscribers.size === 0) return
  for (const subscriber of subscribers) {
    try {
      subscriber({ event, data })
    } catch {
      // A broken subscriber must never take down the run.
    }
  }
}

export function subscribeToRunStream(
  runId: string,
  subscriber: RunStreamSubscriber,
): () => void {
  const bus = getBus()
  let subscribers = bus.subscribers.get(runId)
  if (!subscribers) {
    subscribers = new Set<RunStreamSubscriber>()
    bus.subscribers.set(runId, subscribers)
  }
  subscribers.add(subscriber)
  return () => {
    const current = bus.subscribers.get(runId)
    if (!current) return
    current.delete(subscriber)
    if (current.size === 0) bus.subscribers.delete(runId)
  }
}

/** The terminal event a run already published, if it is still remembered. */
export function getRunTerminalEvent(runId: string): RunStreamEvent | null {
  const memo = getBus().terminal.get(runId)
  if (!memo) return null
  if (Date.now() - memo.at > TERMINAL_MEMO_TTL_MS) {
    getBus().terminal.delete(runId)
    return null
  }
  return memo.event
}

export function runStreamSubscriberCount(runId: string): number {
  return getBus().subscribers.get(runId)?.size ?? 0
}

/** Test helper — drops every subscriber and abort handle. */
export function clearRunStreamBus(): void {
  getBus().subscribers.clear()
  getBus().aborts.clear()
  getBus().terminal.clear()
}
