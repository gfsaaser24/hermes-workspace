/**
 * hermes-jcmm: "Agent Files" — curated read/write access to the editable files
 * of each agent (root HERMES_HOME + every profile under HERMES_HOME/profiles).
 *
 * Allow-list by directory + extension, hard deny for secrets/databases/sessions,
 * path-traversal guard, YAML/JSON validation, timestamped backups, atomic writes,
 * optimistic concurrency (mtime), and a typed-confirm gate for config.yaml keys
 * that change the agent's security posture.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'

export type AgentRef = { id: string; label: string; home: string; isRoot: boolean }

export type AgentFileNode = {
  path: string // relative to the agent home, posix separators
  name: string
  type: 'file' | 'folder'
  size?: number
  mtimeMs?: number
  children?: AgentFileNode[]
}

const TOP_LEVEL_FILES = new Set([
  'SOUL.md',
  'AGENTS.md',
  'INTEGRATIONS.md',
  'CRON-MIGRATION.md',
  'config.yaml',
  'profile.yaml',
  'tasks.json',
  'channel_directory.json',
])

// Folders that are browsed recursively. `skills` is intentionally NOT here:
// it is huge (bundled skills copied per profile) and has its own page.
const ALLOWED_DIRS = ['memories', 'scripts', 'hooks', 'tools', 'workspace', 'cron', 'plugins', 'clickup', 'migration-records']

const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.yaml', '.yml', '.json', '.toml', '.ini', '.cfg',
  '.sh', '.bash', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.env.example',
])

const DENY_NAMES = new Set(['.env', 'auth.json', 'auth.lock', 'credentials', 'sessions', 'node_modules', '.git', 'pairing', 'state', 'runtime', 'sandboxes', 'cache', 'audio_cache', 'image_cache', 'logs', 'backups', 'tmp', 'webui_state'])
const DENY_PATTERNS = [/\.db(-\w+)?$/i, /\.lock$/i, /\.sqlite3?$/i, /\.bak-\d{8}-\d{6}$/]

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_DEPTH = 6
const BACKUPS_TO_KEEP = 5

// config.yaml keys whose change requires an explicit confirmation from the UI.
const SENSITIVE_CONFIG_KEYS = ['approvals', 'security', 'command_allowlist', 'privacy', 'gateway']

export function getHermesRoot(): string {
  const envHome = (process.env.HERMES_HOME || process.env.CLAUDE_HOME || '').trim()
  return envHome ? path.resolve(envHome) : path.resolve(path.join(os.homedir(), '.hermes'))
}

export function listAgents(): AgentRef[] {
  const root = getHermesRoot()
  const agents: AgentRef[] = [{ id: 'root', label: 'Workspace (root)', home: root, isRoot: true }]
  const profilesDir = path.join(root, 'profiles')
  if (fs.existsSync(profilesDir)) {
    for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      agents.push({ id: entry.name, label: entry.name, home: path.join(profilesDir, entry.name), isRoot: false })
    }
  }
  return agents
}

function resolveAgent(agentId: string): AgentRef {
  const id = (agentId || '').trim()
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(id)) throw new Error('Invalid agent id')
  const agent = listAgents().find((a) => a.id === id)
  if (!agent) throw new Error('Agent not found')
  return agent
}

function isDenied(name: string): boolean {
  if (DENY_NAMES.has(name)) return true
  return DENY_PATTERNS.some((re) => re.test(name))
}

function isTextFile(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower.endsWith('.env.example')) return true
  const ext = path.extname(lower)
  if (TEXT_EXTENSIONS.has(ext)) return true
  // extension-less scripts / hook handlers are fine when small
  return ext === '' && !isDenied(name)
}

/** Validate + resolve a relative path inside the agent home. */
function resolveInside(agent: AgentRef, relativePath: string): { abs: string; rel: string } {
  const raw = (relativePath || '').replace(/\\/g, '/').trim()
  if (!raw) throw new Error('Path is required')
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) throw new Error('Absolute paths are not allowed')
  const segments = raw.split('/').filter(Boolean)
  if (segments.some((s) => s === '..' || s === '.')) throw new Error('Path traversal is not allowed')
  if (segments.some((s) => isDenied(s))) throw new Error('This file is not editable through Agent Files')
  const first = segments[0]
  const allowed = segments.length === 1 ? TOP_LEVEL_FILES.has(first) : ALLOWED_DIRS.includes(first)
  if (!allowed) throw new Error('This path is outside the editable set')
  if (!isTextFile(segments[segments.length - 1])) throw new Error('Only text files can be edited here')
  const abs = path.resolve(agent.home, ...segments)
  const homeReal = fs.realpathSync(agent.home)
  const parentReal = fs.existsSync(path.dirname(abs)) ? fs.realpathSync(path.dirname(abs)) : path.dirname(abs)
  if (parentReal !== homeReal && !parentReal.startsWith(homeReal + path.sep)) {
    throw new Error('Path resolves outside the agent home')
  }
  return { abs, rel: segments.join('/') }
}

function walk(dirAbs: string, relBase: string, depth: number): AgentFileNode[] {
  if (depth > MAX_DEPTH) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true })
  } catch {
    return []
  }
  const nodes: AgentFileNode[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || isDenied(entry.name)) continue
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name
    const abs = path.join(dirAbs, entry.name)
    if (entry.isDirectory()) {
      const children = walk(abs, rel, depth + 1)
      if (children.length) nodes.push({ path: rel, name: entry.name, type: 'folder', children })
    } else if (entry.isFile() && isTextFile(entry.name)) {
      try {
        const st = fs.statSync(abs)
        if (st.size <= MAX_FILE_BYTES) nodes.push({ path: rel, name: entry.name, type: 'file', size: st.size, mtimeMs: st.mtimeMs })
      } catch {
        /* skip unreadable */
      }
    }
  }
  // folders first
  return nodes.sort((a, b) => (a.type === b.type ? 0 : a.type === 'folder' ? -1 : 1))
}

export function listAgentFiles(agentId: string): { agent: AgentRef; tree: AgentFileNode[] } {
  const agent = resolveAgent(agentId)
  const tree: AgentFileNode[] = []
  for (const name of TOP_LEVEL_FILES) {
    const abs = path.join(agent.home, name)
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const st = fs.statSync(abs)
      tree.push({ path: name, name, type: 'file', size: st.size, mtimeMs: st.mtimeMs })
    }
  }
  for (const dir of ALLOWED_DIRS) {
    const abs = path.join(agent.home, dir)
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      const children = walk(abs, dir, 1)
      if (children.length) tree.push({ path: dir, name: dir, type: 'folder', children })
    }
  }
  return { agent, tree }
}

export function readAgentFile(agentId: string, relativePath: string): { path: string; content: string; mtimeMs: number; size: number } {
  const agent = resolveAgent(agentId)
  const { abs, rel } = resolveInside(agent, relativePath)
  const st = fs.statSync(abs)
  if (!st.isFile()) throw new Error('Not a file')
  if (st.size > MAX_FILE_BYTES) throw new Error('File too large to edit here (2 MB max)')
  return { path: rel, content: fs.readFileSync(abs, 'utf8'), mtimeMs: st.mtimeMs, size: st.size }
}

function validateContent(rel: string, content: string): void {
  const lower = rel.toLowerCase()
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    YAML.parse(content) // throws with a useful message
  } else if (lower.endsWith('.json')) {
    JSON.parse(content)
  }
}

/** Keys under config.yaml that changed between two documents (top-level only). */
function changedSensitiveKeys(before: string, after: string): string[] {
  let a: unknown
  let b: unknown
  try {
    a = YAML.parse(before)
    b = YAML.parse(after)
  } catch {
    return []
  }
  const ra = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>
  const rb = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>
  return SENSITIVE_CONFIG_KEYS.filter((k) => JSON.stringify(ra[k] ?? null) !== JSON.stringify(rb[k] ?? null))
}

function rotateBackups(abs: string): void {
  const dir = path.dirname(abs)
  const base = path.basename(abs)
  let backups: string[]
  try {
    backups = fs.readdirSync(dir).filter((n) => n.startsWith(`${base}.bak-`)).sort()
  } catch {
    return
  }
  while (backups.length > BACKUPS_TO_KEEP) {
    const victim = backups.shift()
    if (victim) fs.rmSync(path.join(dir, victim), { force: true })
  }
}

function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export type WriteResult =
  | { ok: true; path: string; mtimeMs: number; backup: string | null }
  | { ok: false; code: 'conflict' | 'confirm_required' | 'invalid'; message: string; sensitiveKeys?: string[]; mtimeMs?: number }

export function writeAgentFile(
  agentId: string,
  relativePath: string,
  content: string,
  opts: { expectedMtimeMs?: number | null; confirmSensitive?: boolean } = {},
): WriteResult {
  const agent = resolveAgent(agentId)
  const { abs, rel } = resolveInside(agent, relativePath)
  if (typeof content !== 'string') throw new Error('content must be a string')
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('Content too large (2 MB max)')

  try {
    validateContent(rel, content)
  } catch (err) {
    return { ok: false, code: 'invalid', message: `Validation failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  const exists = fs.existsSync(abs)
  const before = exists ? fs.readFileSync(abs, 'utf8') : ''
  const st = exists ? fs.statSync(abs) : null

  if (st && typeof opts.expectedMtimeMs === 'number' && Math.abs(st.mtimeMs - opts.expectedMtimeMs) > 1) {
    return { ok: false, code: 'conflict', message: 'File changed on disk since you opened it. Reload before saving.', mtimeMs: st.mtimeMs }
  }

  if (path.basename(rel) === 'config.yaml' && !opts.confirmSensitive) {
    const keys = changedSensitiveKeys(before, content)
    if (keys.length) {
      return { ok: false, code: 'confirm_required', message: `This save changes security-sensitive config: ${keys.join(', ')}.`, sensitiveKeys: keys }
    }
  }

  let backup: string | null = null
  if (exists && before !== content) {
    backup = `${abs}.bak-${timestamp()}`
    fs.copyFileSync(abs, backup)
    rotateBackups(abs)
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, content, 'utf8')
  if (st) {
    try {
      fs.chmodSync(tmp, st.mode & 0o777)
    } catch {
      /* best effort */
    }
  }
  fs.renameSync(tmp, abs)
  const after = fs.statSync(abs)
  return { ok: true, path: rel, mtimeMs: after.mtimeMs, backup: backup ? path.basename(backup) : null }
}

/** Restart the whole Coolify application (agent + UIs). Server-side only; needs env. */
export async function restartAgentViaCoolify(): Promise<{ ok: boolean; message: string }> {
  const url = (process.env.COOLIFY_URL || '').trim().replace(/\/+$/, '')
  const token = (process.env.COOLIFY_TOKEN || '').trim()
  const app = (process.env.COOLIFY_APP_UUID || '').trim()
  if (!url || !token || !app) return { ok: false, message: 'Restart is not configured (COOLIFY_URL / COOLIFY_TOKEN / COOLIFY_APP_UUID).' }
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  const cfId = (process.env.CF_ACCESS_CLIENT_ID || '').trim()
  const cfSecret = (process.env.CF_ACCESS_CLIENT_SECRET || '').trim()
  if (cfId && cfSecret) {
    headers['CF-Access-Client-Id'] = cfId
    headers['CF-Access-Client-Secret'] = cfSecret
  }
  try {
    const res = await fetch(`${url}/api/v1/applications/${encodeURIComponent(app)}/restart`, { method: 'POST', headers, signal: AbortSignal.timeout(20000) })
    const text = await res.text().catch(() => '')
    if (!res.ok) return { ok: false, message: `Coolify responded ${res.status}: ${text.slice(0, 200)}` }
    return { ok: true, message: 'Restart requested. The agent (and this UI) will be back in about a minute.' }
  } catch (err) {
    return { ok: false, message: `Restart request failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
