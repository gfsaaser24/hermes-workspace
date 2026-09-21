import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * hermes-jcmm: replay ordering + live-tail bus for the run resume path.
 */

const originalHermesHome = process.env.HERMES_HOME

let tempHome: string | null = null

beforeEach(() => {
  vi.resetModules()
  tempHome = mkdtempSync(join(tmpdir(), 'hermes-run-resume-'))
  process.env.HERMES_HOME = tempHome
})

afterEach(() => {
  if (tempHome) rmSync(tempHome, { recursive: true, force: true })
  tempHome = null
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  vi.resetModules()
})

describe('buildRunReplayEvents', () => {
  it('replays lifecycle, then tool cards in order, then thinking, then text', async () => {
    const store = await import('./run-store')
    const { buildRunReplayEvents } = await import('./run-resume')

    await store.createPersistedRun({
      runId: 'run-a',
      sessionKey: 'sess-a',
      friendlyId: 'Nice Chat',
    })
    await store.upsertRunToolCall('sess-a', 'run-a', {
      id: 'tc-1',
      name: 'read_file',
      phase: 'start',
      args: { path: 'a.txt' },
    })
    await store.upsertRunToolCall('sess-a', 'run-a', {
      id: 'tc-2',
      name: 'write_file',
      phase: 'complete',
      result: 'ok',
    })
    await store.upsertRunToolCall('sess-a', 'run-a', {
      id: 'tc-1',
      name: 'read_file',
      phase: 'complete',
      result: 'file body',
    })
    await store.setRunThinking('sess-a', 'run-a', 'weighing options')
    await store.appendRunText('sess-a', 'run-a', 'Hello ')
    await store.appendRunText('sess-a', 'run-a', 'world')

    const run = await store.getPersistedRun('sess-a', 'run-a')
    expect(run).toBeTruthy()
    const events = buildRunReplayEvents(run!)

    expect(events.map((e) => e.event)).toEqual([
      'started',
      'tool',
      'tool',
      'thinking',
      'chunk',
    ])
    // Tool order is insertion order, and an upsert keeps the original slot.
    expect(events[1].data.toolCallId).toBe('tc-1')
    expect(events[1].data.phase).toBe('complete')
    expect(events[1].data.result).toBe('file body')
    expect(events[2].data.toolCallId).toBe('tc-2')
    expect(events[3].data.text).toBe('weighing options')
    // Text always replays as the full accumulated value.
    expect(events[4].data).toMatchObject({
      text: 'Hello world',
      fullReplace: true,
    })
    expect(events[0].data).toMatchObject({
      runId: 'run-a',
      sessionKey: 'sess-a',
      friendlyId: 'Nice Chat',
      resumed: true,
    })
  })

  it('appends a terminal done event when the run already finished', async () => {
    const store = await import('./run-store')
    const { buildRunReplayEvents } = await import('./run-resume')

    await store.createPersistedRun({ runId: 'run-b', sessionKey: 'sess-b' })
    await store.appendRunText('sess-b', 'run-b', 'done text')
    await store.markRunStatus('sess-b', 'run-b', 'complete')

    const run = await store.getPersistedRun('sess-b', 'run-b')
    const events = buildRunReplayEvents(run!)
    const last = events[events.length - 1]
    expect(last.event).toBe('done')
    expect(last.data.state).toBe('complete')
  })

  it('reports an errored run as done/error with the stored message', async () => {
    const store = await import('./run-store')
    const { buildRunTerminalEvent } = await import('./run-resume')

    await store.createPersistedRun({ runId: 'run-c', sessionKey: 'sess-c' })
    await store.markRunStatus('sess-c', 'run-c', 'error', 'boom')

    const run = await store.getPersistedRun('sess-c', 'run-c')
    expect(buildRunTerminalEvent(run!).data).toMatchObject({
      state: 'error',
      errorMessage: 'boom',
    })
  })
})

describe('isRunStalled', () => {
  it('flags a run whose persisted state stopped advancing', async () => {
    const { isRunStalled } = await import('./run-resume')
    const base = {
      runId: 'r',
      sessionKey: 's',
      friendlyId: 's',
      status: 'active' as const,
      createdAt: 0,
      updatedAt: 1_000,
      lastEventAt: 1_000,
      assistantText: '',
      thinkingText: '',
      toolCalls: [],
      lifecycleEvents: [],
    }
    expect(isRunStalled(base, 2_000, 5_000)).toBe(false)
    expect(isRunStalled(base, 9_000, 5_000)).toBe(true)
    expect(isRunStalled({ ...base, status: 'complete' }, 9_000, 5_000)).toBe(
      false,
    )
  })
})

describe('run-stream-bus', () => {
  it('fans events out per run and stops after unsubscribe', async () => {
    const { publishRunEvent, subscribeToRunStream, runStreamSubscriberCount } =
      await import('./run-stream-bus')

    const seenA: Array<string> = []
    const seenB: Array<string> = []
    const offA = subscribeToRunStream('run-1', (e) => seenA.push(e.event))
    const offB = subscribeToRunStream('run-2', (e) => seenB.push(e.event))

    publishRunEvent('run-1', 'chunk', { text: 'hi' })
    publishRunEvent('run-2', 'tool', { name: 't' })
    expect(seenA).toEqual(['chunk'])
    expect(seenB).toEqual(['tool'])

    offA()
    expect(runStreamSubscriberCount('run-1')).toBe(0)
    publishRunEvent('run-1', 'done', {})
    expect(seenA).toEqual(['chunk'])
    offB()
  })

  it('keeps delivering to the remaining subscribers when one throws', async () => {
    const { publishRunEvent, subscribeToRunStream, clearRunStreamBus } =
      await import('./run-stream-bus')
    clearRunStreamBus()

    const seen: Array<string> = []
    const offBad = subscribeToRunStream('run-x', () => {
      throw new Error('subscriber blew up')
    })
    const offGood = subscribeToRunStream('run-x', (e) => seen.push(e.event))

    expect(() => publishRunEvent('run-x', 'chunk', {})).not.toThrow()
    expect(seen).toEqual(['chunk'])
    offBad()
    offGood()
  })
})
