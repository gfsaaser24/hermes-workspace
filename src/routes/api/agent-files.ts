/**
 * hermes-jcmm: Agent Files API.
 *   GET  /api/agent-files                      -> { agents }
 *   GET  /api/agent-files?agent=<id>           -> { agent, tree }
 *   GET  /api/agent-files?agent=<id>&path=<p>  -> { path, content, mtimeMs, size }
 *   POST /api/agent-files  { action: 'write', agent, path, content, expectedMtimeMs?, confirmSensitive? }
 *   POST /api/agent-files  { action: 'restart' }
 */
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  listAgentFiles,
  listAgents,
  readAgentFile,
  restartAgentViaCoolify,
  writeAgentFile,
} from '../../server/agent-files'

function errorStatus(message: string): number {
  if (/not found/i.test(message) || /ENOENT/.test(message)) return 404
  if (/not allowed|outside|traversal|invalid|required|not editable|only text|too large|not a file/i.test(message)) return 400
  return 500
}

export const Route = createFileRoute('/api/agent-files')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ error: 'Unauthorized' }, { status: 401 })
        const url = new URL(request.url)
        const agent = url.searchParams.get('agent') || ''
        const filePath = url.searchParams.get('path') || ''
        try {
          if (!agent) return json({ agents: listAgents().map(({ id, label, isRoot }) => ({ id, label, isRoot })) })
          if (!filePath) {
            const { agent: ref, tree } = listAgentFiles(agent)
            return json({ agent: { id: ref.id, label: ref.label, isRoot: ref.isRoot }, tree })
          }
          return json(readAgentFile(agent, filePath))
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Agent files request failed'
          return json({ error: message }, { status: errorStatus(message) })
        }
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ error: 'Unauthorized' }, { status: 401 })
        let body: Record<string, unknown>
        try {
          body = (await request.json()) as Record<string, unknown>
        } catch {
          return json({ error: 'Invalid JSON body' }, { status: 400 })
        }
        const action = typeof body.action === 'string' ? body.action : 'write'
        try {
          if (action === 'restart') {
            const result = await restartAgentViaCoolify()
            return json(result, { status: result.ok ? 200 : 503 })
          }
          if (action !== 'write') return json({ error: 'Unknown action' }, { status: 400 })
          const result = writeAgentFile(
            String(body.agent || ''),
            String(body.path || ''),
            typeof body.content === 'string' ? body.content : '',
            {
              expectedMtimeMs: typeof body.expectedMtimeMs === 'number' ? body.expectedMtimeMs : null,
              confirmSensitive: body.confirmSensitive === true,
            },
          )
          if (!result.ok) {
            const status = result.code === 'conflict' ? 409 : result.code === 'confirm_required' ? 412 : 422
            return json(result, { status })
          }
          return json(result)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Agent files write failed'
          return json({ error: message }, { status: errorStatus(message) })
        }
      },
    },
  },
})
