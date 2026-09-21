// @vitest-environment jsdom
/**
 * hermes-jcmm: attachment lifecycle for useRunResume. Two regressions live
 * here — a session switch clobbering the NEW session's attachment, and a
 * 'stalled' verdict being treated as "done" (which finalised partial text).
 *
 * Uses React.act + createRoot directly (not @testing-library/react) to dodge
 * the vitest ESM/CJS dual-instance issue with React 19 hooks in jsdom — the
 * same approach as -marketplace-install-confirmation.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'

import { useRunResume } from './use-run-resume'
import { useChatStore } from '@/stores/chat-store'

type StreamFrame = { event: string; data: Record<string, unknown> }

const scripts = new Map<string, Array<StreamFrame>>()
/** Per-run delay before the stream response resolves (races the next attach). */
const streamDelays = new Map<string, number>()
const openStreams = new Set<() => void>()

function sseBody(script: Array<StreamFrame>, hold: boolean) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const frame of script) {
        controller.enqueue(
          encoder.encode(
            `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`,
          ),
        )
      }
      if (!hold) {
        controller.close()
        return
      }
      // Stay open like a real live tail until the test tears down.
      openStreams.add(() => {
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      })
    },
  })
}

function installFetch(activeRuns: Record<string, string | null>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const activeMatch = /\/api\/sessions\/([^/]+)\/active-run/.exec(url)
      if (activeMatch) {
        const runId = activeRuns[decodeURIComponent(activeMatch[1])] ?? null
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              run: runId ? { runId, status: 'active' } : null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }
      const streamMatch = /\/api\/runs\/([^/]+)\/([^/]+)\/stream/.exec(url)
      if (streamMatch) {
        const runId = decodeURIComponent(streamMatch[2])
        const script = scripts.get(runId) ?? []
        const hold = !script.some((f) => f.event === 'done')
        const response = new Response(sseBody(script, hold), { status: 200 })
        const delay = streamDelays.get(runId) ?? 0
        if (delay > 0) {
          return new Promise<Response>((resolve) =>
            setTimeout(() => resolve(response), delay),
          )
        }
        return Promise.resolve(response)
      }
      return Promise.resolve(new Response('{}', { status: 404 }))
    }),
  )
}

type HookResult = ReturnType<typeof useRunResume>

function mountHook(
  initialSessionKey: string,
  onRunComplete?: () => void,
): {
  latest: () => HookResult
  setSessionKey: (key: string) => Promise<void>
  unmount: () => Promise<void>
} {
  const seen: { current: HookResult | null } = { current: null }
  let setKey: ((key: string) => void) | null = null

  function Harness() {
    const [sessionKey, setSessionKey] = React.useState(initialSessionKey)
    setKey = setSessionKey
    seen.current = useRunResume({
      sessionKey,
      enabled: true,
      isLocalStreamActive: false,
      onRunComplete,
    })
    return null
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  void React.act(() => {
    root.render(React.createElement(Harness))
  })

  return {
    latest: () => seen.current!,
    setSessionKey: async (key: string) => {
      await React.act(async () => {
        setKey?.(key)
        await Promise.resolve()
      })
    },
    unmount: async () => {
      await React.act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

async function settle(ms = 60) {
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

beforeEach(() => {
  scripts.clear()
  streamDelays.clear()
  openStreams.clear()
  useChatStore.setState({
    realtimeMessages: new Map(),
    streamingState: new Map(),
    sendStreamRunIds: new Set(),
    waitingSessionKeys: new Set(),
    waitingSessionMeta: {},
  })
})

afterEach(() => {
  for (const close of openStreams) close()
  openStreams.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useRunResume attachment', () => {
  it('does not clobber session B when switching away from session A', async () => {
    // A's stream resolves LATE, so its teardown lands after B has attached —
    // that is exactly the window in which the identity guard matters.
    scripts.set('run-a', [
      { event: 'started', data: { runId: 'run-a', sessionKey: 'A' } },
      {
        event: 'done',
        data: { runId: 'run-a', sessionKey: 'A', state: 'complete' },
      },
    ])
    streamDelays.set('run-a', 150)
    scripts.set('run-b', [
      { event: 'started', data: { runId: 'run-b', sessionKey: 'B' } },
      {
        event: 'chunk',
        data: { runId: 'run-b', text: 'B is typing', fullReplace: true },
      },
    ])
    installFetch({ A: 'run-a', B: 'run-b' })

    const hook = mountHook('A')
    await settle(20)
    expect(hook.latest().resumedRunId).toBe('run-a')

    // Switch to B before A's stream even opens. A's late teardown must not
    // wipe B's attachment.
    await hook.setSessionKey('B')
    await settle(60)
    expect(hook.latest().resumedRunId).toBe('run-b')
    await settle(250)

    expect(hook.latest().resumedRunId).toBe('run-b')
    expect(useChatStore.getState().isSessionWaiting('B')).toBe(true)
    expect(useChatStore.getState().getStreamingState('B')?.text).toBe(
      'B is typing',
    )
    await hook.unmount()
  })

  it('keeps the banner and the waiting state when the server reports a stall', async () => {
    scripts.set('run-s', [
      { event: 'started', data: { runId: 'run-s', sessionKey: 'S' } },
      {
        event: 'chunk',
        data: { runId: 'run-s', text: 'half', fullReplace: true },
      },
      {
        event: 'done',
        data: { runId: 'run-s', sessionKey: 'S', state: 'stalled' },
      },
    ])
    installFetch({ S: 'run-s' })
    const onRunComplete = vi.fn()

    const hook = mountHook('S', onRunComplete)
    await settle(120)

    expect(hook.latest().resumeStalled).toBe(true)
    expect(hook.latest().resumedRunId).toBe('run-s')
    expect(useChatStore.getState().isSessionWaiting('S')).toBe(true)
    expect(useChatStore.getState().getStreamingState('S')?.text).toBe('half')
    expect(useChatStore.getState().getRealtimeMessages('S')).toHaveLength(0)
    expect(onRunComplete).not.toHaveBeenCalled()
    await hook.unmount()
  })

  it('clears the waiting state and refetches history once the run completes', async () => {
    scripts.set('run-c', [
      { event: 'started', data: { runId: 'run-c', sessionKey: 'C' } },
      {
        event: 'chunk',
        data: { runId: 'run-c', text: 'all done', fullReplace: true },
      },
      {
        event: 'done',
        data: { runId: 'run-c', sessionKey: 'C', state: 'complete' },
      },
    ])
    installFetch({ C: 'run-c' })
    const onRunComplete = vi.fn()

    const hook = mountHook('C', onRunComplete)
    await settle(120)

    expect(onRunComplete).toHaveBeenCalled()
    expect(hook.latest().resumedRunId).toBeNull()
    expect(hook.latest().resumeStalled).toBe(false)
    expect(useChatStore.getState().isSessionWaiting('C')).toBe(false)
    await hook.unmount()
  })
})
