// hermes-jcmm: read what a hermes-lcm compaction folded away, for the
// "Context compacted here" divider. lcm.db lives next to state.db (root
// HERMES_HOME and each profile); `summary_nodes` keeps, per compaction,
// the source message ids and their token count. Read-only, best effort —
// a missing db or table just means no numbers on the divider.
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { getHermesRoot } from './claude-paths'

export type CompactionStats = {
  node: number
  messages: number
  sourceTokens: number
  summaryTokens: number
  createdAt: number | null
  earliestAt: number | null
  latestAt: number | null
}

type SummaryNodeRow = {
  node_id: number
  session_id: string
  token_count: number | null
  source_token_count: number | null
  source_ids: string | null
  created_at: number | null
  earliest_at: number | null
  latest_at: number | null
}

const MARKER_NODE_RE = /^\s*\[Recent Summary \([^)]*?node (\d+)\)\]/i

export function parseCompactionNode(text: string | null | undefined): number | null {
  const match = MARKER_NODE_RE.exec(text ?? '')
  if (!match) return null
  const node = Number(match[1])
  return Number.isFinite(node) ? node : null
}

function lcmDbCandidates(): Array<string> {
  const root = getHermesRoot()
  const candidates = [path.join(root, 'lcm.db')]
  const profilesDir = path.join(root, 'profiles')
  try {
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(path.join(profilesDir, entry.name, 'lcm.db'))
      }
    }
  } catch {
    /* no profiles dir */
  }
  return candidates.filter((file) => existsSync(file))
}

function countSourceIds(raw: string | null): number {
  if (!raw) return 0
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

async function openReadOnly(file: string): Promise<{
  prepare: (sql: string) => { get: (...params: Array<unknown>) => unknown }
  close: () => void
} | null> {
  try {
    // node:sqlite ships with Node 22 (experimental, stable enough for a read).
    const mod = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (
        path: string,
        options?: { readOnly?: boolean },
      ) => {
        prepare: (sql: string) => { get: (...params: Array<unknown>) => unknown }
        close: () => void
      }
    }
    return new mod.DatabaseSync(file, { readOnly: true })
  } catch {
    return null
  }
}

const statsCache = new Map<string, CompactionStats | null>()

export async function readCompactionStats(
  sessionId: string,
  node: number,
): Promise<CompactionStats | null> {
  const cacheKey = `${sessionId}:${node}`
  if (statsCache.has(cacheKey)) return statsCache.get(cacheKey) ?? null
  let found: CompactionStats | null = null
  for (const file of lcmDbCandidates()) {
    const db = await openReadOnly(file)
    if (!db) continue
    try {
      const row = db
        .prepare(
          'SELECT node_id, session_id, token_count, source_token_count, source_ids, created_at, earliest_at, latest_at FROM summary_nodes WHERE node_id = ? AND session_id = ?',
        )
        .get(node, sessionId) as SummaryNodeRow | undefined
      if (row) {
        found = {
          node,
          messages: countSourceIds(row.source_ids),
          sourceTokens: Number(row.source_token_count) || 0,
          summaryTokens: Number(row.token_count) || 0,
          createdAt: row.created_at ? Number(row.created_at) * 1000 : null,
          earliestAt: row.earliest_at ? Number(row.earliest_at) * 1000 : null,
          latestAt: row.latest_at ? Number(row.latest_at) * 1000 : null,
        }
        break
      }
    } catch {
      /* table missing or locked — try the next db */
    } finally {
      try {
        db.close()
      } catch {
        /* ignore */
      }
    }
  }
  // Only cache hits: a node may be written moments after the marker row.
  if (found) statsCache.set(cacheKey, found)
  return found
}
