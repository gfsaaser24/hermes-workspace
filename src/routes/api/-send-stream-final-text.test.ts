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

const hoisted = vi.hoisted(() => ({
  baseUrl: 'http://127.0.0.1:1',
  chatMode: 'enhanced-claude' as 'enhanced-claude' | 'portable',
}))

vi.mock('../../server/auth-middleware', () => ({
  isAuthenticated: () => true,
}))

vi.mock('../../server/gateway-capabilities', () => ({
  get CLAUDE_API() {
    return hoisted.baseUrl
  },
  BEARER_TOKEN: '',
  SESSIONS_API_UNAVAILABLE_MESSAGE: 'sessions unavailable',
  getChatMode: () => hoisted.chatMode,
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

type Scenario =
  | 'final-text-only'
  | 'blank-assistant-completed'
  // Hermes Agent v0.21.3: ONE assistant.completed per turn whose `content`
  // is every intermediate reply glued together (api_server.py `_delta` feeds
  // one message_id; `final_response` is the whole turn).
  | 'interleaved-one-completed'
  // Builds that close each assistant message of the turn on its own.
  | 'interleaved-per-message-completed'
  // chatMode 'portable': /v1/chat/completions with hermes.tool.progress
  // frames between the text deltas.
  | 'portable-interleaved'

let scenario: Scenario = 'final-text-only'
let server: Server | null = null
let tempHome: string | null = null
const originalEnv = { ...process.env }

function sse(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function startFakeGateway(): Promise<string> {
  server = createServer((req, res) => {
    // chatMode 'portable' talks to the OpenAI-compatible surface.
    if (req.url?.includes('/v1/chat/completions')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const delta = (content: string) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
      const toolFrame = (status: 'running' | 'completed') =>
        sse('hermes.tool.progress', {
          tool: 'read_file',
          label: 'read a.txt',
          tool_call_id: 'tc-1',
          status,
        })
      void (async () => {
        const tick = () => new Promise((r) => setTimeout(r, 10))
        res.write(delta('one'))
        await tick()
        res.write(toolFrame('running'))
        await tick()
        res.write(toolFrame('completed'))
        await tick()
        // The agent keeps talking after the tool — this segment, not the
        // whole turn, is the answer.
        res.write(delta('\n\nDONE'))
        await tick()
        res.write('data: [DONE]\n\n')
        res.end()
      })()
      return
    }
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
      if (
        scenario === 'interleaved-one-completed' ||
        scenario === 'interleaved-per-message-completed'
      ) {
        const perMessage = scenario === 'interleaved-per-message-completed'
        const tick = () => new Promise((r) => setTimeout(r, 10))
        const toolPair = async (id: string) => {
          res.write(
            sse('tool.started', {
              ...base,
              tool_call: {
                id,
                tool_name: 'read_file',
                arguments: '{"path":"a.txt"}',
              },
            }),
          )
          await tick()
          res.write(
            sse('tool.completed', {
              ...base,
              tool_call: { id, tool_name: 'read_file' },
              result_preview: 'ok',
            }),
          )
          await tick()
        }
        const segments = perMessage ? ['one', 'DONE'] : ['one', 'two', 'DONE']
        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i]
          // The live agent's deltas carry the blank-line separators.
          res.write(
            sse('assistant.delta', {
              ...base,
              delta: perMessage ? seg : `\n\n${seg}`,
            }),
          )
          await tick()
          if (perMessage) {
            res.write(sse('assistant.completed', { ...base, content: seg }))
            await tick()
          }
          if (i < segments.length - 1) await toolPair(`tc-${i + 1}`)
        }
        if (!perMessage) {
          // The whole turn in one payload — this is what used to become the
          // persisted answer AND the bubble the browser kept.
          res.write(
            sse('assistant.completed', {
              ...base,
              content: '\n\none\n\ntwo\n\nDONE',
            }),
          )
          await tick()
        }
        res.write(
          sse('run.completed', {
            ...base,
            messages: perMessage
              ? []
              : [
                  { role: 'assistant', content: 'one' },
                  { role: 'tool', content: 'ok' },
                  { role: 'assistant', content: 'two' },
                  { role: 'tool', content: 'ok' },
                  { role: 'assistant', content: 'DONE' },
                ],
          }),
        )
        res.end()
        return
      }
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

async function send(sessionKey: string = SESSION): Promise<Array<ParsedEvent>> {
  const sendStream = await import('./send-stream')
  const handlers = (sendStream as any).Route.options.server.handlers
  const response = (await handlers.POST({
    request: new Request('http://localhost/api/send-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey, message: 'go' }),
    }),
  })) as Response
  expect(response.status).toBe(200)
  return readUntilDone(response)
}

async function settledRun(runId: string, sessionKey: string = SESSION) {
  const runStore = await import('../../server/run-store')
  let run = await runStore.getPersistedRun(sessionKey, runId)
  for (let i = 0; i < 40 && run?.status !== 'complete'; i++) {
    await new Promise((r) => setTimeout(r, 25))
    run = await runStore.getPersistedRun(sessionKey, runId)
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
  // Skip the /v1/models round-trip openaiChat would otherwise make.
  process.env.CLAUDE_DEFAULT_MODEL = 'test-model'
  hoisted.chatMode = 'enhanced-claude'
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

/**
 * hermes-jcmm: a turn that talks between tool calls must finish on its LAST
 * assistant message, not on every intermediate reply glued together.
 *
 * Seen live (v0.21.3): the agent says "one", runs a tool, says "two", runs a
 * tool, ... then "DONE". Every assistant.delta was appended into one buffer
 * and the single end-of-turn assistant.completed carries the whole turn, so
 * the run persisted "\n\none\n\ntwo\n\nDONE" and the browser kept a realtime
 * bubble with all of it — while the transcript held "DONE" as its own row.
 * The chat-store dedupes the `done` message against history by exact text, so
 * the mismatch showed BOTH until a reload.
 */
function doneMessageText(events: Array<ParsedEvent>): string {
  const message = events.find((e) => e.event === 'done')?.data.message as
    | { content?: Array<Record<string, unknown>> }
    | undefined
  const parts = Array.isArray(message?.content) ? message.content : []
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
}

describe('send-stream ends a turn on its last assistant message', () => {
  it('keeps only the final reply when one assistant.completed carries the whole turn', async () => {
    scenario = 'interleaved-one-completed'
    const events = await send()
    const runId = String(
      events.find((e) => e.event === 'started')?.data.runId ?? '',
    )
    expect(runId).not.toBe('')
    expect(events.find((e) => e.event === 'done')?.data.state).toBe('complete')

    // The last full-replace chunk must not re-paint the whole turn either.
    const replaces = events.filter(
      (e) => e.event === 'chunk' && e.data.fullReplace === true,
    )
    expect(replaces.length).toBeGreaterThan(0)
    expect(String(replaces[replaces.length - 1].data.text).trim()).toBe('DONE')

    const run = await settledRun(runId)
    expect(run?.status).toBe('complete')
    expect((run?.assistantText ?? '').trim()).toBe('DONE')

    expect(doneMessageText(events).trim()).toBe('DONE')
  }, 20000)

  it('keeps only the final reply when each assistant message is completed on its own', async () => {
    scenario = 'interleaved-per-message-completed'
    const events = await send()
    const runId = String(
      events.find((e) => e.event === 'started')?.data.runId ?? '',
    )
    expect(runId).not.toBe('')

    expect(doneMessageText(events).trim()).toBe('DONE')

    const run = await settledRun(runId)
    expect(run?.status).toBe('complete')
    expect((run?.assistantText ?? '').trim()).toBe('DONE')
  }, 20000)

  /**
   * The live box runs chatMode 'portable' against v0.21.3's
   * /v1/chat/completions, and /api/history reads the AGENT transcript first
   * (src/routes/api/history.ts) — which splits the turn into one row per
   * reply. So the portable path has to end on the last segment too, or the
   * realtime bubble ("one … DONE") and the transcript row ("DONE") both show.
   */
  it('portable: keeps only the segment after the last tool call', async () => {
    hoisted.chatMode = 'portable'
    scenario = 'portable-interleaved'
    const sessionKey = `sess-portable-${Date.now()}`
    const events = await send(sessionKey)
    const runId = String(
      events.find((e) => e.event === 'started')?.data.runId ?? '',
    )
    expect(runId).not.toBe('')
    expect(events.find((e) => e.event === 'done')?.data.state).toBe('complete')

    expect(doneMessageText(events).trim()).toBe('DONE')
    expect(doneMessageText(events)).not.toContain('one')

    const run = await settledRun(runId, sessionKey)
    expect(run?.status).toBe('complete')
    expect((run?.assistantText ?? '').trim()).toBe('DONE')
    expect(run?.assistantText ?? '').not.toContain('one')
  }, 20000)
})
