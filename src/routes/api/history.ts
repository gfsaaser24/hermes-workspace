import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import {
  SESSIONS_API_UNAVAILABLE_MESSAGE,
  ensureGatewayProbed,
  getGatewayCapabilities,
  getMessages,
  getMessagesWithCompacted,
  listSessions,
  toChatMessage,
  getSession,
} from '../../server/claude-api'
import {
  resolveMainChatSessionId,
  resolveSessionKey,
  shouldBindMainToPortableSession, hasRealMainSession } from '../../server/session-utils'
import { isAuthenticated } from '@/server/auth-middleware'
import { getLocalSession, getLocalMessages } from '../../server/local-session-store'
import { readCompactionStats } from '../../server/lcm-stats'

export const Route = createFileRoute('/api/history')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        await ensureGatewayProbed()
        const capabilities = getGatewayCapabilities()
        if (!capabilities.sessions) {
          return json({
            sessionKey: 'new',
            sessionId: 'new',
            messages: [],
            source: 'unavailable',
            message: SESSIONS_API_UNAVAILABLE_MESSAGE,
          })
        }
        try {
          const url = new URL(request.url)
          const limit = Number(url.searchParams.get('limit') || '200')
          const rawSessionKey = url.searchParams.get('sessionKey')?.trim()
          const friendlyId = url.searchParams.get('friendlyId')?.trim()
          let { sessionKey } = await resolveSessionKey({
            rawSessionKey,
            friendlyId,
            defaultKey: 'main',
          })
          const realMain = sessionKey === 'main' && (await hasRealMainSession())
          const pinPortableMain =
            !realMain &&
            shouldBindMainToPortableSession({
              sessionKey,
              dashboardAvailable: capabilities.dashboard.available,
              enhancedChat: capabilities.enhancedChat,
            })
          // Keep /chat/new empty until the first message creates a real session.
          if (sessionKey === 'new') {
            return json({
              sessionKey: 'new',
              sessionId: 'new',
              messages: [],
            })
          }
          // "main" doesn't exist in Claude — resolve it to the user's real
          // main chat session. We prefer (in order):
          //   1. The most recent session with a real human-set title
          //      (label !== id, e.g. "hows everything"). This is what users
          //      actually mean by "main".
          //   2. The most recent non-internal session with messages.
          // Cron + Operations per-agent sessions are skipped so the
          // orchestrator chat doesn't latch onto runtime junk.
          if (sessionKey === 'main' && !pinPortableMain && !realMain) {
            try {
              const sessions = await listSessions(30, 0)
              const candidate = resolveMainChatSessionId(sessions)
              if (candidate) {
                sessionKey = candidate
              } else {
                return json({
                  sessionKey: 'new',
                  sessionId: 'new',
                  messages: [],
                })
              }
            } catch {
              return json({ sessionKey: 'new', sessionId: 'new', messages: [] })
            }
          }

          if (pinPortableMain) {
            const localMessages = getLocalMessages('main')
            return json({
              sessionKey: 'main',
              sessionId: 'main',
              messages: localMessages.map((m, index) => ({
                id: m.id,
                role: m.role,
                content: [{ type: 'text', text: m.content }],
                timestamp: m.timestamp,
                historyIndex: index,
              })),
            })
          }
          let messages: Awaited<ReturnType<typeof getMessages>> = []
          try {
            // hermes-jcmm: include compacted rows (capped) so a compacted
            // chat still scrolls back; the summary row becomes a divider.
            messages = await getMessagesWithCompacted(sessionKey)
          } catch {
            messages = []
          }

          // Fallback to local session store for portable/local model sessions
          if (messages.length === 0) {
            const localSession = getLocalSession(sessionKey)
            if (localSession) {
              const localMessages = getLocalMessages(sessionKey)
              return json({
                sessionKey,
                sessionId: sessionKey,
                messages: localMessages.map((m, index) => ({
                  id: m.id,
                  role: m.role,
                  content: [{ type: 'text', text: m.content }],
                  timestamp: m.timestamp,
                  historyIndex: index,
                })),
              })
            }
          }

          const boundedMessages = limit > 0 ? messages.slice(-limit) : messages
          const chatMessages = boundedMessages.map((message, index) =>
            toChatMessage(message, { historyIndex: index }),
          )
          // hermes-jcmm: put numbers on each "context compacted here" divider.
          // hermes-lcm: from lcm.db summary_nodes (messages, tokens, when).
          // Stock compressor: count the compacted rows since the last marker.
          let sinceLastMarker = 0
          for (let i = 0; i < chatMessages.length; i++) {
            const chat = chatMessages[i]
            const raw = boundedMessages[i] as { compacted?: unknown }
            if (chat.__compactionMarker !== true) {
              if (Number(raw.compacted) === 1) sinceLastMarker += 1
              continue
            }
            const node = typeof chat.__compactionNode === 'number' ? chat.__compactionNode : null
            const markerAt = typeof chat.timestamp === 'number' ? chat.timestamp : null
            const stats = await readCompactionStats(sessionKey, node, markerAt)
            chat.__compaction = {
              node,
              messages: stats?.messages || sinceLastMarker,
              sourceTokens: stats?.sourceTokens ?? 0,
              summaryTokens: stats?.summaryTokens ?? 0,
              compactedAt: stats?.createdAt ?? (chat.timestamp as number | undefined) ?? null,
              earliestAt: stats?.earliestAt ?? null,
              latestAt: stats?.latestAt ?? null,
            }
            sinceLastMarker = 0
          }

          return json({
            sessionKey,
            sessionId: sessionKey,
            messages: chatMessages,
          })
        } catch (err) {
          return json(
            {
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
