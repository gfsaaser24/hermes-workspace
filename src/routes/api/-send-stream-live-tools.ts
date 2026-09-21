type SyntheticLiveToolTracker = {
  emittedPhaseByToolCallId: Map<string, 'calling' | 'complete' | 'error'>
}

type CollectSyntheticLiveToolEventsParams = {
  messages: Array<Record<string, unknown>>
  tracker: SyntheticLiveToolTracker
  sessionKey: string
  runId?: string
}

type SyntheticLiveToolEvent = {
  phase: 'calling' | 'complete' | 'error'
  name: string
  toolCallId: string
  args?: unknown
  result?: string
  sessionKey: string
  runId?: string
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

function parseJsonIfPossible(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed) return value
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return value
    }
  }
  return value
}

function extractToolResultText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((part) => {
      const record = readRecord(part)
      return typeof record?.text === 'string' ? record.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

export function createSyntheticLiveToolTracker(): SyntheticLiveToolTracker {
  return {
    emittedPhaseByToolCallId: new Map(),
  }
}

/**
 * hermes-jcmm: the run-start snapshot used to tell "messages this run wrote"
 * apart from prior turns.
 *
 * A plain array length is NOT enough: the Hermes dashboard pages
 * `GET /api/sessions/{id}/messages` to the newest 500 rows when no `limit` is
 * sent (hermes_cli/web_routers/sessions.py). On a long session the array
 * length stays pinned at 500, so `slice(baselineCount)` is always empty and no
 * live tool card is ever emitted. Anchor on the highest row id instead and keep
 * the count only as a fallback for stores that don't expose numeric ids.
 */
export type RunMessageWindow = {
  baselineCount: number
  baselineMaxId: number
}

function readRowId(message: Record<string, unknown>): number {
  const id = Number(message.id)
  return Number.isFinite(id) ? id : Number.NaN
}

export function createRunMessageWindow(
  baseline: Array<Record<string, unknown>> | null | undefined,
): RunMessageWindow {
  if (!Array.isArray(baseline)) return { baselineCount: 0, baselineMaxId: 0 }
  let baselineMaxId = 0
  for (const message of baseline) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime safety
    if (!message) continue
    const id = readRowId(message)
    if (Number.isFinite(id) && id > baselineMaxId) baselineMaxId = id
  }
  return { baselineCount: baseline.length, baselineMaxId }
}

export function selectRunMessages(
  window: RunMessageWindow,
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (!Array.isArray(messages)) return []
  if (window.baselineMaxId > 0) {
    return messages.filter((message) => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime safety
      if (!message) return false
      const id = readRowId(message)
      return Number.isFinite(id) && id > window.baselineMaxId
    })
  }
  return messages.slice(window.baselineCount)
}

export function collectSyntheticLiveToolEvents({
  messages,
  tracker,
  sessionKey,
  runId,
}: CollectSyntheticLiveToolEventsParams): Array<SyntheticLiveToolEvent> {
  const resultByCallId = new Map<string, { text: string; isError: boolean }>()
  const runToolCalls: Array<Record<string, unknown>> = []

  for (const message of messages) {
    if (!message) continue

    if (message.role === 'tool' || message.role === 'tool_result') {
      const callId =
        readString(message.tool_call_id) || readString(message.toolCallId)
      if (!callId) continue
      resultByCallId.set(callId, {
        text: extractToolResultText(message),
        isError: Boolean(message.is_error) || Boolean(message.isError),
      })
      continue
    }

    if (message.role === 'assistant') {
      const toolCalls = (message.tool_calls ?? message.toolCalls) as
        | Array<Record<string, unknown>>
        | undefined
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        runToolCalls.push(...toolCalls)
      }
    }
  }

  const events: Array<SyntheticLiveToolEvent> = []

  for (const toolCall of runToolCalls) {
    const toolFunction = readRecord(toolCall.function)
    const toolCallId =
      readString(toolCall.id) || readString(toolCall.tool_call_id) || ''
    if (!toolCallId) continue

    const name =
      readString(toolCall.tool_name) ||
      readString(toolCall.name) ||
      readString(toolFunction?.name) ||
      'tool'
    const args = parseJsonIfPossible(toolFunction?.arguments ?? toolCall.arguments)
    const resultEntry = resultByCallId.get(toolCallId)
    const nextPhase = resultEntry
      ? resultEntry.isError
        ? 'error'
        : 'complete'
      : 'calling'
    const previousPhase = tracker.emittedPhaseByToolCallId.get(toolCallId)

    if (previousPhase === nextPhase) continue
    if (
      previousPhase &&
      (previousPhase === 'complete' || previousPhase === 'error')
    ) {
      continue
    }

    tracker.emittedPhaseByToolCallId.set(toolCallId, nextPhase)
    events.push({
      phase: nextPhase,
      name,
      toolCallId,
      args,
      result: resultEntry?.text || undefined,
      sessionKey,
      runId,
    })
  }

  return events
}
