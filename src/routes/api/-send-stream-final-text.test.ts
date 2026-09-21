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
 * hermes-jcmm: a finished run must never persist an empty answer.
 *
 * Seen live (run bfd175a1, 61 tool calls): status 'complete' but
 * assistantText: '' — no assistant.delta arrived and assistant.completed
 * carried blank content, so nothing ever wrote the reply. The agent's
 * run.completed payload carries the authoritative per-turn transcript, so
 * send-stream now falls back to it when the client was told no text.
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
    // Empty session transcript on purpose: the final text must come from the
    // run.completed payload alone.
    getMessages: async () => [],
    lockSessionModel: async () => undefined,
    listSessions: async () => [],
    getSession: async () => null,
    createSession: async () => ({ id: 'sess-final-text' }),
  }
})

vi.mock('./workspace', () => ({
  loadWorkspaceCatalog: async () => null,
}))

const SESSION = 'sess-final-text'
const RUN = 'run-final-text'
const FINAL_TEXT = 'The answer that only run.completed knew about.'
const STREAMED_TEXT = 'Streamed answer.'

type Scenario = 'final-text-only' | 'blank-assistant-completed'

let scenario: Scenario = 'final-text-only'
let server: Server | null = null
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
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const base: Record<string, unknown> = {
      run_id: RUN,
      session_id: SESSION,
    }
    void (async () => {
      res.write(sse('run.started', { ...base }))
      await new Promise((r) => setTimeout(r, 10))
      res.write(
        sse('message.started', {
          ...base,
          message: { id: 'msg-1', role: 'assistant' },
        }),
      )
      await new Promise((r) => setTimeout(r, 10))
      if (scenario === 'final-text-only') {
        // No deltas, and an assistant.completed with nothing in it — the
        // exact shape that used to leave assistantText: ''.
        res.write(sse('assistant.completed', { ...base, content: '' }))
        await new Promise((r) => setTimeout(r, 10))
        res.write(
          sse('run.completed', {
            ...base,
            messages: [
              { role: 'assistant', content: FINAL_TEXT },
              { role: 'tool', content: 'tool output' },
              // Trailing tool-call-only assistant row: no text to take.
              { role: 'assistant', content: '' },
            ],
          }),
        )
      } else {
        res.write(
          sse('assistant.completed', { ...base, content: STREAMED_TEXT }),
        )
        await new Promise((r) => setTimeout(r, 10))
        // A second, whitespace-only completion must not wipe the answer.
        res.write(sse('assistant.completed', { ...base, content: '   \n  ' }))
        await new Promise((r) => setTimeout(r, 10))
        res.write(sse('run.completed', { ...base, messages: [] }))
      }
      res.end()
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

async function readUntilDone(response: Response): Promise<Array<ParsedEvent>> {
  const reader = response.body!.getReader()
  const parse = createSseParser()
  const events: Array<ParsedEvent> = []
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const { done, value } = await reader.read()
    if (done) break
    events.push(...parse(value))
    if (events.some((e) => e.event === 'done')) break
  }
  await reader.cancel().catch(() => undefined)
  return events
}

async function send(): Promise<Array<ParsedEvent>> {
  const sendStream = await import('./send-stream')
  const handlers = (sendStream as any).Route.options.server.handlers
  const response = (await handlers.POST({
    request: new Request('http://localhost/api/send-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey: SESSION, message: 'go' }),
    }),
  })) as Response
  expect(response.status).toBe(200)
  return readUntilDone(response)
}

async function settledRun(runId: string) {
  const runStore = await import('../../server/run-store')
  let run = await runStore.getPersistedRun(SESSION, runId)
  for (let i = 0; i < 40 && run?.status !== 'complete'; i++) {
    await new Promise((r) => setTimeout(r, 25))
    run = await runStore.getPersistedRun(SESSION, runId)
  }
  return run
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
  tempHome = mkdtempSync(join(tmpdir(), 'hermes-final-text-'))
  process.env.HERMES_HOME = tempHome
})

afterEach(() => {
  if (tempHome) rmSync(tempHome, { recursive: true, force: true })
  tempHome = null
  process.env = { ...originalEnv }
})

describe('send-stream persists the final assistant text', () => {
  it('takes the answer off run.completed when no text ever streamed', async () => {
    scenario = 'final-text-only'
    const events = await send()
    const runId = String(
      events.find((e) => e.event === 'started')?.data.runId ?? '',
    )
    expect(runId).not.toBe('')
    expect(events.find((e) => e.event === 'done')?.data.state).toBe('complete')

    const run = await settledRun(runId)
    expect(run?.status).toBe('complete')
    expect(run?.assistantText).toBe(FINAL_TEXT)
  }, 20000)

  it('does not let a whitespace-only assistant.completed blank the answer', async () => {
    scenario = 'blank-assistant-completed'
    const events = await send()
    const runId = String(
      events.find((e) => e.event === 'started')?.data.runId ?? '',
    )
    expect(runId).not.toBe('')

    // The browser is never told to replace the answer with whitespace.
    const chunks = events.filter((e) => e.event === 'chunk')
    expect(chunks.length).toBe(1)
    expect(chunks[0].data.text).toBe(STREAMED_TEXT)

    const run = await settledRun(runId)
    expect(run?.status).toBe('complete')
    expect(run?.assistantText).toBe(STREAMED_TEXT)
  }, 20000)
})
