import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { Server } from 'node:http'
import type * as ClaudeApi from '../../server/claude-api'

/**
 * hermes-jcmm: end-to-end proof that a run survives the browser.
 *
 * A tiny fake Hermes gateway streams run.started → tool.started →
 * tool.completed → (pause) → assistant.completed → run.completed. The
 * "browser" cancels its /api/send-stream reader during the pause; the
 * Workspace must keep consuming the agent stream, keep persisting to
 * run-store, and a resumed client must see the earlier tool card plus the
 * final text.
 */

const hoisted = vi.hoisted(() => ({ baseUrl: 'http://127.0.0.1:1' }))

vi.mock('../../server/auth-middleware', () => ({
  isAuthenticated: () => true,
}))

vi.mock('../../server/gateway-capabilities', () => ({
  get CLAUDE_API() {
    return hoisted.baseUrl
  },
  BEARER_TOKEN: '',
  SESSIONS_API_UNAVAILABLE_MESSAGE: 'sessions unavailable',
  getChatMode: () => 'enhanced-claude',
  getCapabilities: () => ({ dashboard: { available: false }, sessions: true }),
  ensureGatewayProbed: async () => ({}),
  probeGateway: async () => ({}),
  dashboardFetch: async () => {
    throw new Error('no dashboard in tests')
  },
}))

vi.mock('../../server/claude-api', async (importOriginal) => {
  const actual = await importOriginal<typeof ClaudeApi>()
  return {
    ...actual,
    // streamChat stays REAL so the fake gateway exercises the true SSE path.
    ensureGatewayProbed: async () => ({}),
    getGatewayCapabilities: () => ({ sessions: true }),
    getMessages: async () => [],
    lockSessionModel: async () => undefined,
    listSessions: async () => [],
    getSession: async () => null,
    createSession: async () => ({ id: 'sess-e2e' }),
  }
})

vi.mock('./workspace', () => ({
  loadWorkspaceCatalog: async () => null,
}))

const SESSION = 'sess-e2e'
const RUN = 'run-e2e'

type Gate = {
  release: () => void
  aborted: boolean
  finished: Promise<void>
}

let server: Server | null = null
let gate: Gate
let tempHome: string | null = null
const originalEnv = { ...process.env }

function sse(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function startFakeGateway(): Promise<string> {
  server = createServer((req, res) => {
    if (!req.url?.includes('/chat/stream')) {
      res.writeHead(404).end()
      return
    }
    // Fresh gate per request so each test gets its own pause point.
    let releaseTail = () => {}
    const tail = new Promise<void>((resolve) => {
      releaseTail = resolve
    })
    let finishedResolve = () => {}
    const finished = new Promise<void>((resolve) => {
      finishedResolve = resolve
    })
    const local: Gate = { release: releaseTail, aborted: false, finished }
    gate = local

    req.on('aborted', () => {
      local.aborted = true
      releaseTail()
    })
    res.on('close', () => {
      if (!res.writableEnded) local.aborted = true
      releaseTail()
    })
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    void (async () => {
      const base = { run_id: RUN, session_id: SESSION }
      res.write(sse('run.started', { ...base }))
      await new Promise((r) => setTimeout(r, 10))
      res.write(
        sse('tool.started', {
          ...base,
          tool_call: {
            id: 'tc-1',
            tool_name: 'read_file',
            arguments: '{"path":"a.txt"}',
          },
        }),
      )
      await new Promise((r) => setTimeout(r, 10))
      res.write(
        sse('tool.completed', {
          ...base,
          tool_call: { id: 'tc-1', tool_name: 'read_file' },
          result_preview: 'file body',
        }),
      )
      // The browser disconnects (or the user presses Stop) during this pause.
      await tail
      if (local.aborted) {
        finishedResolve()
        return
      }
      res.write(
        sse('assistant.completed', { ...base, content: 'The full answer.' }),
      )
      await new Promise((r) => setTimeout(r, 10))
      res.write(sse('run.completed', { ...base }))
      res.end()
      finishedResolve()
    })()
  })

  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      const address = server!.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve(`http://127.0.0.1:${port}`)
    })
  })
}

type ParsedEvent = { event: string; data: Record<string, unknown> }

function createSseParser() {
  const decoder = new TextDecoder()
  let buffer = ''
  return (chunk: Uint8Array): Array<ParsedEvent> => {
    buffer += decoder.decode(chunk, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    const out: Array<ParsedEvent> = []
    for (const block of blocks) {
      if (!block.trim() || block.trimStart().startsWith(':')) continue
      let event = ''
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim()
        else if (line.startsWith('data: ')) data += line.slice(6)
      }
      if (!event) continue
      out.push({
        event,
        data: data ? (JSON.parse(data) as Record<string, unknown>) : {},
      })
    }
    return out
  }
}

async function readUntil(
  response: Response,
  stop: (events: Array<ParsedEvent>) => boolean,
  budgetMs = 5000,
): Promise<Array<ParsedEvent>> {
  const reader = response.body!.getReader()
  const parse = createSseParser()
  const events: Array<ParsedEvent> = []
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const { done, value } = await reader.read()
    if (done) break
    events.push(...parse(value))
    if (stop(events)) break
  }
  await reader.cancel().catch(() => undefined)
  return events
}

async function waitFor(check: () => boolean, budgetMs = 3000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline && !check()) {
    await new Promise((r) => setTimeout(r, 20))
  }
}

beforeAll(async () => {
  hoisted.baseUrl = await startFakeGateway()
})

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve()
    server.close(() => resolve())
  })
  server = null
})

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'hermes-resume-e2e-'))
  process.env.HERMES_HOME = tempHome
  process.env.HERMES_RUN_RESUME_SETTLE_MS = '0'
  process.env.HERMES_RUN_RESUME_HEARTBEAT_MS = '50'
  process.env.HERMES_RUN_RESUME_POLL_MS = '40'
  process.env.HERMES_RUN_RESUME_STALL_MS = '100000'
})

afterEach(() => {
  if (tempHome) rmSync(tempHome, { recursive: true, force: true })
  tempHome = null
  process.env = { ...originalEnv }
})

describe('send-stream survives the browser disconnecting mid-run', () => {
  it('keeps the agent run alive and lets a resumed client see the tool card and final text', async () => {
    const sendStream = await import('./send-stream')
    const resumeRoute = await import('./runs/$sessionKey.$runId.stream')
    const runStore = await import('../../server/run-store')

    const sendHandlers = (sendStream as any).Route.options.server.handlers
    const response = (await sendHandlers.POST({
      request: new Request('http://localhost/api/send-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey: SESSION, message: 'go' }),
      }),
    })) as Response
    expect(response.status).toBe(200)

    // The "browser" watches until the first tool card completes…
    const reader = response.body!.getReader()
    const parse = createSseParser()
    const seen: Array<ParsedEvent> = []
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break
      seen.push(...parse(value))
      if (
        seen.some((e) => e.event === 'tool' && e.data.phase === 'complete')
      ) {
        break
      }
    }
    expect(seen.some((e) => e.event === 'started')).toBe(true)
    expect(
      seen.some((e) => e.event === 'tool' && e.data.phase === 'complete'),
    ).toBe(true)

    // …then goes away (reload / tab close).
    await reader.cancel()
    await new Promise((r) => setTimeout(r, 50))

    // The run must still be live — not flipped to a terminal state.
    const midRun = await runStore.getPersistedRun(SESSION, RUN)
    expect(midRun).toBeTruthy()
    expect(['accepted', 'active']).toContain(midRun!.status)

    // A new client re-attaches and gets the replay + live tail.
    const resumeHandlers = (resumeRoute as any).Route.options.server.handlers
    const resumeResponse = (await resumeHandlers.GET({
      request: new Request('http://localhost/api/runs/x/y/stream'),
      params: { sessionKey: SESSION, runId: RUN },
    })) as Response
    expect(resumeResponse.status).toBe(200)

    const resumed = readUntil(resumeResponse, (evts) =>
      evts.some((e) => e.event === 'done'),
    )

    await new Promise((r) => setTimeout(r, 60))
    gate.release()
    await gate.finished

    const events = (await resumed).filter((e) => e.event !== 'heartbeat')
    const names = events.map((e) => e.event)

    // Replay: the tool card the disconnected client already saw.
    expect(names[0]).toBe('started')
    const toolEvent = events.find((e) => e.event === 'tool')
    expect(toolEvent?.data).toMatchObject({
      toolCallId: 'tc-1',
      name: 'read_file',
      phase: 'complete',
    })

    // Live tail: the answer that only arrived after the disconnect.
    const finalChunk = [...events]
      .reverse()
      .find((e) => e.event === 'chunk')
    expect(finalChunk?.data.text).toBe('The full answer.')
    expect(finalChunk?.data.fullReplace).toBe(true)
    expect(names[names.length - 1]).toBe('done')

    // The Workspace never aborted the upstream agent request.
    expect(gate.aborted).toBe(false)

    // run-store writes are fire-and-forget behind a queue; give them a beat.
    let finalRun = await runStore.getPersistedRun(SESSION, RUN)
    for (let i = 0; i < 40 && finalRun?.status !== 'complete'; i++) {
      await new Promise((r) => setTimeout(r, 25))
      finalRun = await runStore.getPersistedRun(SESSION, RUN)
    }
    expect(finalRun?.status).toBe('complete')
    expect(finalRun?.assistantText).toBe('The full answer.')
  }, 20000)
  it('aborts the upstream gateway request when the user presses Stop', async () => {
    const sendStream = await import('./send-stream')
    const resumeRoute = await import('./runs/$sessionKey.$runId.stream')
    const abandonRoute = await import('./runs/$sessionKey.$runId.abandon')
    const runStore = await import('../../server/run-store')

    const sendHandlers = (sendStream as any).Route.options.server.handlers
    const response = (await sendHandlers.POST({
      request: new Request('http://localhost/api/send-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey: SESSION, message: 'go' }),
      }),
    })) as Response

    const reader = response.body!.getReader()
    const parse = createSseParser()
    const seen: Array<ParsedEvent> = []
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break
      seen.push(...parse(value))
      if (seen.some((e) => e.event === 'tool' && e.data.phase === 'complete')) {
        break
      }
    }
    expect(seen.some((e) => e.event === 'started')).toBe(true)

    // Another tab is watching the run when Stop is pressed.
    const resumeHandlers = (resumeRoute as any).Route.options.server.handlers
    const resumeResponse = (await resumeHandlers.GET({
      request: new Request('http://localhost/api/runs/x/y/stream'),
      params: { sessionKey: SESSION, runId: RUN },
    })) as Response
    const resumed = readUntil(resumeResponse, (evts) =>
      evts.some((e) => e.event === 'done'),
    )
    await new Promise((r) => setTimeout(r, 60))

    // The user presses Stop.
    const abandonHandlers = (abandonRoute as any).Route.options.server.handlers
    const stopRes = (await abandonHandlers.POST({
      request: new Request('http://localhost/api/runs/x/y/abandon', {
        method: 'POST',
      }),
      params: { sessionKey: SESSION, runId: RUN },
    })) as Response
    expect(stopRes.status).toBe(200)
    const stopBody = (await stopRes.json()) as Record<string, unknown>
    expect(stopBody.ok).toBe(true)
    expect(stopBody.stopped).toBe(true)

    // The upstream gateway request really was aborted this time.
    await waitFor(() => gate.aborted)
    expect(gate.aborted).toBe(true)

    // The resumed tab is told to close.
    const events = (await resumed).filter((e) => e.event !== 'heartbeat')
    const done = events.find((e) => e.event === 'done')
    expect(done?.data.state).toBe('stopped')

    const run = await runStore.getPersistedRun(SESSION, RUN)
    expect(run?.status).toBe('stopped')

    // Idempotent: a second Stop is still a success, and no run re-attaches.
    const second = (await abandonHandlers.POST({
      request: new Request('http://localhost/api/runs/x/y/abandon', {
        method: 'POST',
      }),
      params: { sessionKey: SESSION, runId: RUN },
    })) as Response
    expect(second.status).toBe(200)
    expect(((await second.json()) as Record<string, unknown>).ok).toBe(true)
    expect(await runStore.getActiveRunForSession(SESSION)).toBeNull()

    await reader.cancel().catch(() => undefined)
    gate.release()
  }, 20000)

  it('404s when there is no such run to stop', async () => {
    const abandonRoute = await import('./runs/$sessionKey.$runId.abandon')
    const handlers = (abandonRoute as any).Route.options.server.handlers
    const res = (await handlers.POST({
      request: new Request('http://localhost/api/runs/x/y/abandon', {
        method: 'POST',
      }),
      params: { sessionKey: 'ghost', runId: 'ghost' },
    })) as Response
    expect(res.status).toBe(404)
  })
})
