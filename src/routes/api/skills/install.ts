import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  BEARER_TOKEN,
  CLAUDE_API,
  ensureGatewayProbed, dashboardFetch,
} from '../../../server/gateway-capabilities'

function authHeaders(): Record<string, string> {
  return BEARER_TOKEN ? { Authorization: `Bearer ${BEARER_TOKEN}` } : {}
}

export const Route = createFileRoute('/api/skills/install')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const body = (await request.json()) as {
            skillId?: string
            identifier?: string
            category?: string
            force?: boolean
          }
          const identifier =
            (body.identifier || body.skillId || '').trim()
          if (!identifier) {
            return json(
              { ok: false, error: 'identifier or skillId required' },
              { status: 400 },
            )
          }

          const capabilities = await ensureGatewayProbed()
          if (capabilities.dashboard.available) {
            // hermes-jcmm: the official dashboard installs hub skills
            // (spawns `hermes skills install <id> --yes` in the agent container).
            const res = await dashboardFetch('/api/skills/hub/install', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ identifier }),
              signal: AbortSignal.timeout(120_000),
            })
            const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>
            return json(
              res.ok ? { ok: true, ...payload } : { ok: false, error: String(payload.detail || payload.error || `HTTP ${res.status}`) },
              { status: res.ok ? 200 : res.status },
            )
          }

          const response = await fetch(`${CLAUDE_API}/api/skills/install`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...authHeaders(),
            },
            body: JSON.stringify({
              identifier,
              category: body.category || '',
              force: Boolean(body.force),
            }),
            signal: AbortSignal.timeout(120_000),
          })

          const result = await response.json()
          return json(result, { status: response.status })
        } catch (error) {
          return json(
            {
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to install skill',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
