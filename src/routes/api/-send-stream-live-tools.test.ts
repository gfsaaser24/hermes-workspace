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
})
