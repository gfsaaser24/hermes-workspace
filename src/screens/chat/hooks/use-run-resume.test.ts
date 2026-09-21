import { beforeEach, describe, expect, it } from 'vitest'

import { applyResumeEvent } from './use-run-resume'
import { useChatStore } from '@/stores/chat-store'

/**
 * hermes-jcmm: the resume stream replays events in the shapes the chat store
 * already understands. These cover the hydrate path — what the UI ends up
 * showing after a reload mid-run.
 */

const SESSION = 'sess-resume'

function hydrate(event: string, data: Record<string, unknown>) {
  return applyResumeEvent({
    event,
    data: { runId: 'run-1', sessionKey: SESSION, ...data },
    sessionKey: SESSION,
    processEvent: useChatStore.getState().processEvent,
  })
}

beforeEach(() => {
  useChatStore.setState({
    realtimeMessages: new Map(),
    streamingState: new Map(),
    sendStreamRunIds: new Set(),
    waitingSessionKeys: new Set(),
    waitingSessionMeta: {},
  })
})

describe('applyResumeEvent', () => {
  it('rebuilds tool cards and assistant text from a replay', () => {
    expect(hydrate('started', { resumed: true })).toBe('open')
    expect(
      hydrate('tool', {
        phase: 'complete',
        name: 'read_file',
        toolCallId: 'tc-1',
        args: { path: 'a.txt' },
        result: 'body',
      }),
    ).toBe('open')
    hydrate('tool', {
      phase: 'calling',
      name: 'write_file',
      toolCallId: 'tc-2',
    })
    hydrate('thinking', { text: 'weighing options' })
    hydrate('chunk', { text: 'Half an answer', fullReplace: true })

    const streaming = useChatStore.getState().getStreamingState(SESSION)
    expect(streaming).toBeTruthy()
    expect(streaming!.text).toBe('Half an answer')
    expect(streaming!.thinking).toBe('weighing options')
    expect(streaming!.toolCalls.map((tc) => tc.id)).toEqual(['tc-1', 'tc-2'])
    expect(streaming!.toolCalls[0]).toMatchObject({
      name: 'read_file',
      phase: 'complete',
      result: 'body',
    })
    expect(streaming!.runId).toBe('run-1')
  })

  it('treats replayed chunks as the full accumulated text, never a delta', () => {
    hydrate('chunk', { text: 'one', fullReplace: true })
    hydrate('chunk', { text: 'one two', fullReplace: true })
    expect(useChatStore.getState().getStreamingState(SESSION)!.text).toBe(
      'one two',
    )
  })

  it('upserts a tool card the replay already delivered instead of duplicating it', () => {
    hydrate('tool', { phase: 'start', name: 'bash', toolCallId: 'tc-9' })
    hydrate('tool', {
      phase: 'complete',
      name: 'bash',
      toolCallId: 'tc-9',
      result: 'exit 0',
    })
    const toolCalls =
      useChatStore.getState().getStreamingState(SESSION)!.toolCalls
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toMatchObject({ phase: 'complete', result: 'exit 0' })
  })

  it('finalises the message and clears streaming state on done', () => {
    hydrate('tool', { phase: 'complete', name: 'read_file', toolCallId: 't1' })
    hydrate('chunk', { text: 'Final answer', fullReplace: true })
    expect(hydrate('done', { state: 'complete' })).toBe('done')

    expect(useChatStore.getState().getStreamingState(SESSION)).toBeNull()
    const messages = useChatStore.getState().getRealtimeMessages(SESSION)
    expect(messages).toHaveLength(1)
    expect(JSON.stringify(messages[0].content)).toContain('Final answer')
  })

  it('reports error outcomes so the caller can drop the waiting state', () => {
    expect(hydrate('error', { message: 'nope' })).toBe('error')
    expect(hydrate('done', { state: 'error', errorMessage: 'nope' })).toBe(
      'error',
    )
  })

  it('treats heartbeats and unknown events as proof of life only', () => {
    expect(hydrate('heartbeat', { timestamp: 1 })).toBe('open')
    expect(hydrate('something-new', {})).toBe('open')
    expect(useChatStore.getState().getStreamingState(SESSION)).toBeNull()
  })

  it('renders an artifact as a completed tool card', () => {
    hydrate('artifact', {
      title: 'Report',
      kind: 'markdown',
      path: '/w/report.md',
    })
    const toolCalls =
      useChatStore.getState().getStreamingState(SESSION)!.toolCalls
    expect(toolCalls[0]).toMatchObject({
      name: 'artifact:markdown',
      phase: 'complete',
      result: 'Report — /w/report.md',
    })
  })
})
