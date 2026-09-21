import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { getPersistedRun } from '../../../server/run-store'
import {
  TERMINAL_RUN_STATUSES,
  buildRunReplayEvents,
  buildRunTerminalEvent,
  getRunResumeConfig,
  isRunStalled,
} from '../../../server/run-resume'
import {
  getRunAbort,
  getRunTerminalEvent,
  subscribeToRunStream,
} from '../../../server/run-stream-bus'
import type { RunStreamEvent } from '../../../server/run-stream-bus'

/**
 * hermes-jcmm: GET /api/runs/{sessionKey}/{runId}/stream — re-attach to a run.
 *
 * The browser may have reloaded, switched tabs, or lost its /api/send-stream
 * socket while the agent kept working. This endpoint first REPLAYS everything
 * run-store persisted for the run (tool cards, thinking, assistant text so
 * far) and then TAILS the live run-stream bus until the run reaches a terminal
 * state. A keepalive goes out at least every 15s so proxies (Cloudflare
 * Access / Traefik) never cull an idle stream during a long tool call.
 */
export const Route = createFileRoute('/api/runs/$sessionKey/$runId/stream')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        const sessionKey = params.sessionKey.trim()
        const runId = params.runId.trim()
        if (!sessionKey || !runId) {
          return json(
            { ok: false, error: 'sessionKey and runId required' },
            { status: 400 },
          )
        }

        const initialRun = await getPersistedRun(sessionKey, runId)
        if (!initialRun) {
          return json({ ok: false, error: 'run not found' }, { status: 404 })
        }

        const config = getRunResumeConfig()
        const encoder = new TextEncoder()
        let streamClosed = false
        let unsubscribe: (() => void) | null = null
        let heartbeatTimer: ReturnType<typeof setInterval> | null = null
        let pollTimer: ReturnType<typeof setInterval> | null = null

        const stream = new ReadableStream({
          async start(controller) {
            const enqueueRaw = (payload: string) => {
              if (streamClosed) return
              try {
                controller.enqueue(encoder.encode(payload))
              } catch {
                streamClosed = true
              }
            }
            const sendEvent = (event: string, data: unknown) => {
              if (streamClosed) return
              enqueueRaw(
                `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
              )
            }
            const closeStream = () => {
              if (streamClosed) return
              streamClosed = true
              if (heartbeatTimer) {
                clearInterval(heartbeatTimer)
                heartbeatTimer = null
              }
              if (pollTimer) {
                clearInterval(pollTimer)
                pollTimer = null
              }
              if (unsubscribe) {
                unsubscribe()
                unsubscribe = null
              }
              try {
                controller.close()
              } catch {
                // already closed
              }
            }

            request.signal.addEventListener('abort', () => closeStream(), {
              once: true,
            })

            // Some proxies only flush once a first chunk is on the wire.
            enqueueRaw(`: ${' '.repeat(2048)}\n\n`)

            // Subscribe BEFORE reading the snapshot so nothing that happens
            // during the read is lost; queued events flush after the replay.
            let tailing = false
            const pending: Array<RunStreamEvent> = []
            const forward = (evt: RunStreamEvent) => {
              sendEvent(evt.event, evt.data)
              if (evt.event === 'done' || evt.event === 'error') closeStream()
            }
            unsubscribe = subscribeToRunStream(runId, (evt) => {
              if (streamClosed) return
              if (!tailing) {
                pending.push(evt)
                return
              }
              forward(evt)
            })

            if (config.settleMs > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, config.settleMs),
              )
            }
            if (streamClosed) return

            const snapshot =
              (await getPersistedRun(sessionKey, runId)) ?? initialRun
            for (const replay of buildRunReplayEvents(snapshot)) {
              sendEvent(replay.event, replay.data)
            }
            if (TERMINAL_RUN_STATUSES.has(snapshot.status)) {
              // buildRunReplayEvents already appended the terminal event.
              closeStream()
              return
            }
            // hermes-jcmm: the run may have ended between the last persisted
            // write and now (e.g. Stop published done before we subscribed).
            // Without this the stream sat on keepalives until the stall window.
            const alreadyDone = getRunTerminalEvent(runId)
            if (alreadyDone) {
              sendEvent(alreadyDone.event, alreadyDone.data)
              closeStream()
              return
            }

            const queued = pending.splice(0, pending.length)
            tailing = true
            for (const evt of queued) {
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- forward() can close the stream mid-loop
              if (streamClosed) break
              forward(evt)
            }
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a queued 'done' closes the stream above
            if (streamClosed) return

            heartbeatTimer = setInterval(() => {
              if (streamClosed) return
              enqueueRaw(': keepalive\n\n')
              sendEvent('heartbeat', { timestamp: Date.now(), runId })
            }, config.heartbeatMs)

            // Safety net: the process that owns the run may have died (server
            // restart, crash). Nothing would ever arrive on the bus, so watch
            // the persisted state and end the stream instead of hanging.
            pollTimer = setInterval(() => {
              if (streamClosed) return
              void (async () => {
                const current = await getPersistedRun(sessionKey, runId)
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the stream can close during the disk read
                if (!current || streamClosed) return
                if (TERMINAL_RUN_STATUSES.has(current.status)) {
                  const terminal = buildRunTerminalEvent(current)
                  sendEvent(terminal.event, terminal.data)
                  closeStream()
                  return
                }
                // A live owner request means the agent is still being read,
                // so silence is not a stall. With no owner in this process the
                // run is almost certainly orphaned — give up much sooner.
                const ownerAlive = Boolean(getRunAbort(runId))
                const window = ownerAlive ? config.stallMs : config.orphanMs
                if (isRunStalled(current, Date.now(), window, ownerAlive)) {
                  sendEvent('done', {
                    sessionKey,
                    runId,
                    state: 'stalled',
                  })
                  closeStream()
                }
              })()
            }, config.pollMs)
          },
          cancel() {
            streamClosed = true
            if (heartbeatTimer) {
              clearInterval(heartbeatTimer)
              heartbeatTimer = null
            }
            if (pollTimer) {
              clearInterval(pollTimer)
              pollTimer = null
            }
            if (unsubscribe) {
              unsubscribe()
              unsubscribe = null
            }
          },
        })

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        })
      },
    },
  },
})
