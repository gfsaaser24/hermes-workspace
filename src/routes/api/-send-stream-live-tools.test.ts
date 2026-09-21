import { describe, expect, it } from 'vitest'

import {
  collectSyntheticLiveToolEvents,
  createRunMessageWindow,
  createSyntheticLiveToolTracker,
  selectRunMessages,
} from './-send-stream-live-tools'

describe('collectSyntheticLiveToolEvents', () => {
  it('emits a live calling event as soon as an assistant tool call appears, before any tool result exists', () => {
    const tracker = createSyntheticLiveToolTracker()

    const events = collectSyntheticLiveToolEvents({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'toolu_1',
              function: {
                name: 'read_file',
                arguments: '{"path":"/tmp/AGENTS.md"}',
              },
            },
          ],
        },
      ],
      tracker,
      sessionKey: 'session-1',
      runId: 'run-1',
    })

    expect(events).toEqual([
      {
        phase: 'calling',
        name: 'read_file',
        toolCallId: 'toolu_1',
        args: { path: '/tmp/AGENTS.md' },
        result: undefined,
        sessionKey: 'session-1',
        runId: 'run-1',
      },
    ])
  })

  it('upgrades the same live tool card to complete when the matching tool result lands', () => {
    const tracker = createSyntheticLiveToolTracker()

    collectSyntheticLiveToolEvents({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'toolu_1',
              function: {
                name: 'read_file',
                arguments: '{"path":"/tmp/AGENTS.md"}',
              },
            },
          ],
        },
      ],
      tracker,
      sessionKey: 'session-1',
      runId: 'run-1',
    })

    const events = collectSyntheticLiveToolEvents({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'toolu_1',
              function: {
                name: 'read_file',
                arguments: '{"path":"/tmp/AGENTS.md"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'toolu_1',
          content: [{ type: 'text', text: 'file contents here' }],
        },
      ],
      tracker,
      sessionKey: 'session-1',
      runId: 'run-1',
    })

    expect(events).toEqual([
      {
        phase: 'complete',
        name: 'read_file',
        toolCallId: 'toolu_1',
        args: { path: '/tmp/AGENTS.md' },
        result: 'file contents here',
        sessionKey: 'session-1',
        runId: 'run-1',
      },
    ])
  })
})

describe('run message window (paged transcripts)', () => {
  // The dashboard pages /api/sessions/{id}/messages to the newest 500 rows,
  // so on a long session the array length never grows and a count-based
  // baseline drops every live tool call.
  function pagedRows(firstId: number, count: number) {
    return Array.from({ length: count }, (_value, index) => ({
      id: firstId + index,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `row ${firstId + index}`,
    }))
  }

  it('keeps emitting tool calls when the transcript page is capped at 500 rows', () => {
    const baseline = pagedRows(601, 500) // ids 601..1100
    const window = createRunMessageWindow(baseline)

    const poll = [
      ...pagedRows(602, 499), // ids 602..1100 — page slid by one
      {
        id: 1101,
        role: 'assistant',
        tool_calls: [
          {
            id: 'toolu_new',
            function: { name: 'read_file', arguments: '{"path":"/tmp/x"}' },
          },
        ],
      },
    ]

    expect(poll).toHaveLength(baseline.length)
    expect(selectRunMessages(window, poll)).toHaveLength(1)

    const events = collectSyntheticLiveToolEvents({
      messages: selectRunMessages(window, poll),
      tracker: createSyntheticLiveToolTracker(),
      sessionKey: 'main',
      runId: 'run-1',
    })

    expect(events).toEqual([
      {
        phase: 'calling',
        name: 'read_file',
        toolCallId: 'toolu_new',
        args: { path: '/tmp/x' },
        result: undefined,
        sessionKey: 'main',
        runId: 'run-1',
      },
    ])
  })

  it('falls back to the count baseline when rows carry no numeric id', () => {
    const window = createRunMessageWindow([{ role: 'user' }, { role: 'assistant' }])
    expect(window.baselineMaxId).toBe(0)
    expect(
      selectRunMessages(window, [
        { role: 'user' },
        { role: 'assistant' },
        { role: 'assistant', tool_calls: [] },
      ]),
    ).toHaveLength(1)
  })

  // hermes-jcmm: rows exactly as Hermes Agent v0.21.3 returns them from the
  // dashboard (`GET :9119/api/sessions/{id}/messages`), captured live on
  // 2026-09-21 for a session whose first turn made three `terminal` calls:
  // `id` is an int and ids are globally monotonic, so the id branch of the
  // window — not the count fallback — is what runs in production.
  //
  // This pins the "off-by-one-turn" guard: a second turn must never replay the
  // first turn's tool calls as live `event: tool` frames. Verified live — the
  // second turn's SSE carried only its own two tool frames.
  it('never re-emits a previous turn from real dashboard rows', () => {
    const terminalCall = (callId: string, command: string) => ({
      id: callId,
      function: { name: 'terminal', arguments: JSON.stringify({ command }) },
    })
    const turnOne = [
      { id: 7196, role: 'user', content: '<workspace_context …>', session_id: 's' },
      { id: 7197, role: 'assistant', content: '', tool_calls: [terminalCall('call_1', 'echo a1')] },
      { id: 7198, role: 'tool', tool_call_id: 'call_1', content: '{"output": "a1"}' },
      { id: 7199, role: 'assistant', content: '', tool_calls: [terminalCall('call_2', 'echo a2')] },
      { id: 7200, role: 'tool', tool_call_id: 'call_2', content: '{"output": "a2"}' },
      { id: 7201, role: 'assistant', content: '', tool_calls: [terminalCall('call_3', 'echo a3')] },
      { id: 7202, role: 'tool', tool_call_id: 'call_3', content: '{"output": "a3"}' },
      { id: 7203, role: 'assistant', content: 'ALPHA' },
    ]

    const window = createRunMessageWindow(turnOne)
    expect(window.baselineMaxId).toBe(7203)

    const turnTwo = [
      ...turnOne,
      { id: 7204, role: 'user', content: 'run b1' },
      {
        id: 7205,
        role: 'assistant',
        content: '',
        tool_calls: [terminalCall('call_4', 'sleep 6; echo b1')],
      },
    ]

    const events = collectSyntheticLiveToolEvents({
      messages: selectRunMessages(window, turnTwo),
      tracker: createSyntheticLiveToolTracker(),
      sessionKey: 'flash-1789998222',
      runId: 'run-2',
    })

    expect(events.map((event) => event.toolCallId)).toEqual(['call_4'])
  })
})
