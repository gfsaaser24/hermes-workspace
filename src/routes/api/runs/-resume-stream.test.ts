import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * hermes-jcmm: GET /api/runs/{sessionKey}/{runId}/stream must replay the
 * persisted run first, then tail the live bus, and must keep the socket warm
 * with a heartbeat so proxies don't cull it during a long tool call.
 */

vi.mock('../../../server/auth-middleware', () => ({
  isAuthenticated: () => true,
}))

const originalEnv = { ...process.env }
let tempHome: string | null = null

beforeEach(() => {
  vi.resetModules()
  tempHome = mkdtempSync(join(tmpdir(), 'hermes-resume-route-'))
  process.env.HERMES_HOME = tempHome
  process.env.HERMES_RUN_RESUME_SETTLE_MS = '0'
  process.env.HERMES_RUN_RESUME_HEARTBEAT_MS = '25'
  process.env.HERMES_RUN_RESUME_POLL_MS = '20'
  process.env.HERMES_RUN_RESUME_STALL_MS = '100000'
})

afterEach(() => {
  if (tempHome) rmSync(tempHome, { recursive: true, force: true })
  tempHome = null
  process.env = { ...originalEnv }
  vi.resetModules()
})

type ParsedEvent = { event: string; data: Record<string, unknown> }

/** Read SSE frames off the response until `stop` says we have enough. */
async function readEvents(
  response: Response,
  stop: (events: Array<ParsedEvent>, raw: string) => boolean,
  budgetMs = 4000,
): Promise<{ events: Array<ParsedEvent>; raw: string }> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const events: Array<ParsedEvent> = []
  let raw = ''
  let buffer = ''
  const deadline = Date.now() + budgetMs

  while (Date.now() < deadline) {
    const { done, value } = await reader.read()
    if (done) break
    const text = decoder.decode(value, { stream: true })
    raw += text
    buffer += text
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      if (!block.trim() || block.trimStart().startsWith(':')) continue
      let event = ''
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim()
        else if (line.startsWith('data: ')) data += line.slice(6)
      }
      if (!event) continue
      events.push({
        event,
        data: data ? (JSON.parse(data) as Record<string, unknown>) : {},
      })
    }
    if (stop(events, raw)) break
  }
  await reader.cancel().catch(() => undefined)
  return { events, raw }
}

async function callStream(sessionKey: string, runId: string) {
  const mod = await import('./$sessionKey.$runId.stream')
  const handlers = (mod as any).Route.options.server.handlers
  return (await handlers.GET({
    request: new Request('http://localhost/api/runs/x/y/stream'),
    params: { sessionKey, runId },
  })) as Response
}

describe('run resume stream route', () => {
  it('404s for an unknown run', async () => {
    const res = await callStream('nope', 'nope')
    expect(res.status).toBe(404)
  })

  it('replays persisted state then closes for a finished run', async () => {
    const store = await import('../../../server/run-store')
    await store.createPersistedRun({ runId: 'r1', sessionKey: 's1' })
    await store.upsertRunToolCall('s1', 'r1', {
      id: 'tc-1',
      name: 'read_file',
      phase: 'complete',
      result: 'contents',
    })
    await store.appendRunText('s1', 'r1', 'final answer')
    await store.markRunStatus('s1', 'r1', 'complete')

    const res = await callStream('s1', 'r1')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/event-stream')

    const { events } = await readEvents(res, (evts) =>
      evts.some((e) => e.event === 'done'),
    )
    expect(events.map((e) => e.event)).toEqual([
      'started',
      'tool',
      'chunk',
      'done',
    ])
    expect(events[1].data.name).toBe('read_file')
    expect(events[2].data.text).toBe('final answer')
    expect(events[3].data.state).toBe('complete')
  })

  it('replays what already happened and then tails live bus events', async () => {
    const store = await import('../../../server/run-store')
    const bus = await import('../../../server/run-stream-bus')

    await store.createPersistedRun({ runId: 'r2', sessionKey: 's2' })
    await store.upsertRunToolCall('s2', 'r2', {
      id: 'tc-old',
      name: 'search_files',
      phase: 'complete',
      result: 'two hits',
    })
    await store.appendRunText('s2', 'r2', 'partial ')

    const res = await callStream('s2', 'r2')
    const collected = readEvents(res, (evts) =>
      evts.some((e) => e.event === 'done'),
    )

    // Give the route a tick to subscribe + replay, then push live events.
    await new Promise((r) => setTimeout(r, 60))
    bus.publishRunEvent('r2', 'tool', {
      sessionKey: 's2',
      runId: 'r2',
      phase: 'complete',
      name: 'write_file',
      toolCallId: 'tc-new',
    })
    bus.publishRunEvent('r2', 'chunk', {
      sessionKey: 's2',
      runId: 'r2',
      text: 'partial answer',
      fullReplace: true,
    })
    bus.publishRunEvent('r2', 'done', {
      sessionKey: 's2',
      runId: 'r2',
      state: 'complete',
    })

    const { events: allEvents } = await collected
    const events = allEvents.filter((e) => e.event !== 'heartbeat')
    const names = events.map((e) => e.event)
    // Replay first…
    expect(names.slice(0, 3)).toEqual(['started', 'tool', 'chunk'])
    expect(events[1].data.toolCallId).toBe('tc-old')
    expect(events[2].data.text).toBe('partial ')
    // …then the live tail.
    const tail = events.slice(3)
    expect(tail.map((e) => e.event)).toEqual(['tool', 'chunk', 'done'])
    expect(tail[0].data.toolCallId).toBe('tc-new')
    expect(tail[1].data.text).toBe('partial answer')
  })

  it('emits heartbeats while the run is idle', async () => {
    const store = await import('../../../server/run-store')
    await store.createPersistedRun({ runId: 'r3', sessionKey: 's3' })
    await store.appendRunText('s3', 'r3', 'thinking hard')

    const res = await callStream('s3', 'r3')
    const { events, raw } = await readEvents(
      res,
      (evts) => evts.filter((e) => e.event === 'heartbeat').length >= 2,
    )
    const heartbeats = events.filter((e) => e.event === 'heartbeat')
    expect(heartbeats.length).toBeGreaterThanOrEqual(2)
    expect(raw).toContain(': keepalive')
  })

  it('ends the stream when the persisted run stops advancing', async () => {
    process.env.HERMES_RUN_RESUME_STALL_MS = '0'
    const store = await import('../../../server/run-store')
    await store.createPersistedRun({ runId: 'r4', sessionKey: 's4' })

    const res = await callStream('s4', 'r4')
    const { events } = await readEvents(res, (evts) =>
      evts.some((e) => e.event === 'done'),
    )
    const done = events.find((e) => e.event === 'done')
    expect(done?.data.state).toBe('stalled')
  })
})
