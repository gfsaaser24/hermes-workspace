/**
 * hermes-jcmm: shared vocabulary for resuming a run that is still executing
 * server-side after the browser dropped its /api/send-stream connection.
 *
 * The replay below re-emits the persisted run state using the SAME SSE event
 * names/shapes the chat client already understands (started / tool / thinking /
 * chunk / done), so a resumed browser needs no second parser.
 */

import type { PersistedRunState } from './run-store'

export type ResumeSseEvent = {
  event: string
  data: Record<string, unknown>
}

export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  'complete',
  'error',
  'stopped',
])

/** Statuses worth re-attaching to. 'handoff' means "browser left", not "dead". */
export const RESUMABLE_RUN_STATUSES: ReadonlySet<string> = new Set([
  'accepted',
  'active',
  'handoff',
  'stalled',
])

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export type RunResumeConfig = {
  /** Keepalive cadence. Must stay <= 15s so proxies don't cull idle streams. */
  heartbeatMs: number
  /** How often the resume stream re-reads the persisted run. */
  pollMs: number
  /**
   * No persisted progress for this long AND no live owner → stalled.
   * Long tool calls can be silent for many minutes, so this is generous.
   */
  stallMs: number
  /** No owner request in this process → the run is orphaned this much sooner. */
  orphanMs: number
  /** Grace before reading the snapshot, so in-flight disk writes land first. */
  settleMs: number
}

export function getRunResumeConfig(): RunResumeConfig {
  return {
    heartbeatMs: envMs('HERMES_RUN_RESUME_HEARTBEAT_MS', 10_000),
    pollMs: envMs('HERMES_RUN_RESUME_POLL_MS', 5_000),
    stallMs: envMs('HERMES_RUN_RESUME_STALL_MS', 900_000),
    orphanMs: envMs('HERMES_RUN_RESUME_ORPHAN_MS', 60_000),
    settleMs: envMs('HERMES_RUN_RESUME_SETTLE_MS', 60),
  }
}

/**
 * Turn the persisted run into the ordered SSE events a late subscriber needs
 * to rebuild the live view: lifecycle first, then tool cards in the order they
 * were opened, then thinking, then the accumulated assistant text, then the
 * terminal event when the run already finished.
 *
 * Text is always emitted with fullReplace so the resumed client never has to
 * guess whether it holds a prefix.
 */
export function buildRunReplayEvents(
  run: PersistedRunState,
): Array<ResumeSseEvent> {
  const base = {
    sessionKey: run.sessionKey,
    runId: run.runId,
  }
  const events: Array<ResumeSseEvent> = [
    {
      event: 'started',
      data: {
        ...base,
        friendlyId: run.friendlyId || run.sessionKey,
        resumed: true,
        status: run.status,
      },
    },
  ]

  for (const toolCall of run.toolCalls) {
    events.push({
      event: 'tool',
      data: {
        ...base,
        phase: toolCall.phase,
        name: toolCall.name,
        toolCallId: toolCall.id,
        args: toolCall.args,
        preview: toolCall.preview,
        result: toolCall.result,
        resumed: true,
      },
    })
  }

  if (run.thinkingText) {
    events.push({
      event: 'thinking',
      data: { ...base, text: run.thinkingText, resumed: true },
    })
  }

  if (run.assistantText) {
    events.push({
      event: 'chunk',
      data: {
        ...base,
        text: run.assistantText,
        fullReplace: true,
        resumed: true,
      },
    })
  }

  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    events.push(buildRunTerminalEvent(run))
  }

  return events
}

export function buildRunTerminalEvent(run: PersistedRunState): ResumeSseEvent {
  const base = { sessionKey: run.sessionKey, runId: run.runId }
  if (run.status === 'stopped') {
    return { event: 'done', data: { ...base, state: 'stopped' } }
  }
  if (run.status === 'error') {
    return {
      event: 'done',
      data: {
        ...base,
        state: 'error',
        errorMessage: run.errorMessage || 'Run failed',
      },
    }
  }
  return { event: 'done', data: { ...base, state: 'complete' } }
}

/**
 * A run whose persisted state stopped advancing is no longer worth tailing —
 * UNLESS the request that owns it is still alive (ownerAlive). A silent tool
 * call is not a stall, and calling it one made the client finalise partial
 * text as if it were the answer.
 */
export function isRunStalled(
  run: PersistedRunState,
  now: number,
  stallMs: number,
  ownerAlive = false,
): boolean {
  if (TERMINAL_RUN_STATUSES.has(run.status)) return false
  if (ownerAlive) return false
  return now - Math.max(run.updatedAt, run.lastEventAt) > stallMs
}
