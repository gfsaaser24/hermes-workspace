import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { stopAgentRun } from '../../../server/claude-api'
import { getPersistedRun, markRunStatus } from '../../../server/run-store'
import {
  getRunAbort,
  publishRunEvent,
  unregisterRunAbort,
} from '../../../server/run-stream-bus'

/**
 * hermes-jcmm: the ONLY way to actually stop a run.
 *
 * A browser disconnect (reload / tab switch / navigation) deliberately keeps
 * the agent working, so the UI Stop button must ask for a stop explicitly.
 * This aborts the upstream Hermes fetch, marks the run terminal, tells any
 * resumed tab to close, and best-effort stops the agent-side run too.
 * Idempotent — stopping an already-stopped run is a no-op success.
 */
export const Route = createFileRoute('/api/runs/$sessionKey/$runId/abandon')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
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

        try {
          const handle = getRunAbort(runId)
          const existing = await getPersistedRun(sessionKey, runId)
          if (!existing && !handle) {
            return json({ ok: false, error: 'run not found' }, { status: 404 })
          }

          if (handle) {
            unregisterRunAbort(runId)
            try {
              handle.abort()
            } catch {
              // the fetch may already be gone
            }
            if (handle.agentRunId) {
              void stopAgentRun(handle.agentRunId)
            }
          }

          const run = await markRunStatus(
            sessionKey,
            runId,
            'stopped',
            'Stopped by user',
          )

          // Close out any tab that re-attached to this run.
          publishRunEvent(runId, 'done', {
            sessionKey,
            runId,
            state: 'stopped',
          })

          return json({ ok: true, stopped: Boolean(handle), run })
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
