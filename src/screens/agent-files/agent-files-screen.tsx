/**
 * hermes-jcmm: Agent Files — edit SOUL.md / AGENTS.md / config.yaml / memories /
 * scripts / hooks / tools for the root agent and every profile, in the browser.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Editor } from '@monaco-editor/react'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toast'
import { resolveTheme, useSettings } from '@/hooks/use-settings'
import { usePageTitle } from '@/hooks/use-page-title'
import { Markdown } from '@/components/prompt-kit/markdown'

type AgentSummary = { id: string; label: string; isRoot: boolean }
type FileNode = { path: string; name: string; type: 'file' | 'folder'; size?: number; mtimeMs?: number; children?: FileNode[] }

const SOUL_TEMPLATE = `# Identity
Who this agent is, in one or two lines.

# Style
- Direct, warm, no filler. Short unless depth earns it.

# Working rules
- Before sending text meant for a human, apply the **humanizer** skill (load it with skill_view("humanizer") if not loaded).

# Avoid
- AI-isms: "delve", "tapestry", "it's important to note".
- Restating the question. Narrating what you are about to do.

# Defaults
- Ambiguous ask -> one clarifying question, then act.
`

// Hermes truncates context files; SOUL should stay well under this.
const SOUL_SOFT_LIMIT = 8000

function languageFor(p: string): string {
  const lower = p.toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown'
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.py')) return 'python'
  if (lower.endsWith('.sh') || lower.endsWith('.bash') || lower.endsWith('.env.example')) return 'shell'
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript'
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs') || lower.endsWith('.jsx')) return 'javascript'
  if (lower.endsWith('.toml') || lower.endsWith('.ini') || lower.endsWith('.cfg')) return 'ini'
  if (lower.endsWith('.html')) return 'html'
  if (lower.endsWith('.css')) return 'css'
  return 'plaintext'
}

function applyNote(p: string): string | null {
  const base = p.split('/').pop() || ''
  if (base === 'SOUL.md' || base === 'AGENTS.md' || p.startsWith('memories/')) return 'Applies to new sessions (the system prompt is built at session start).'
  if (base === 'config.yaml') return 'Most keys are read live; platform/model changes need an agent restart.'
  if (base === 'jobs.json') return 'Cron picks this up on its next tick.'
  if (p.startsWith('hooks/') || p.startsWith('plugins/')) return 'Needs an agent restart.'
  return null
}

function formatBytes(n?: number): string {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function Tree({ nodes, selected, onSelect, depth = 0 }: { nodes: FileNode[]; selected: string | null; onSelect: (p: string) => void; depth?: number }) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  return (
    <ul className="m-0 list-none p-0">
      {nodes.map((node) => {
        const pad = { paddingLeft: `${8 + depth * 14}px` }
        if (node.type === 'folder') {
          const isOpen = open[node.path] ?? depth < 1
          return (
            <li key={node.path}>
              <button
                type="button"
                style={pad}
                onClick={() => setOpen((s) => ({ ...s, [node.path]: !isOpen }))}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs font-medium text-primary-800 hover:bg-primary-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                <span className="w-3 text-primary-500">{isOpen ? '▾' : '▸'}</span>
                <span className="truncate">{node.name}/</span>
              </button>
              {isOpen && node.children ? <Tree nodes={node.children} selected={selected} onSelect={onSelect} depth={depth + 1} /> : null}
            </li>
          )
        }
        const active = selected === node.path
        return (
          <li key={node.path}>
            <button
              type="button"
              style={pad}
              onClick={() => onSelect(node.path)}
              title={`${node.path} · ${formatBytes(node.size)}`}
              className={
                'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-primary-100 dark:hover:bg-neutral-800 ' +
                (active ? 'bg-primary-200 font-medium text-primary-900 dark:bg-neutral-700 dark:text-white' : 'text-primary-700 dark:text-neutral-300')
              }
            >
              <span className="w-3" />
              <span className="truncate">{node.name}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export function AgentFilesScreen() {
  usePageTitle('Agent Files')
  const { settings } = useSettings()
  const theme = resolveTheme(settings.theme)

  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [agentId, setAgentId] = useState<string>('root')
  const [tree, setTree] = useState<FileNode[]>([])
  const [treeLoading, setTreeLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [mtimeMs, setMtimeMs] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const dirty = content !== savedContent
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  // Load agents once.
  useEffect(() => {
    fetch('/api/agent-files')
      .then((r) => r.json())
      .then((d) => setAgents(Array.isArray(d.agents) ? d.agents : []))
      .catch(() => toast('Failed to load agents'))
  }, [])

  const loadTree = useCallback(async (id: string) => {
    setTreeLoading(true)
    try {
      const r = await fetch(`/api/agent-files?agent=${encodeURIComponent(id)}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setTree(Array.isArray(d.tree) ? d.tree : [])
    } catch (e) {
      setTree([])
      toast(`Failed to list files: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setTreeLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadTree(agentId)
  }, [agentId, loadTree])

  const openFile = useCallback(
    async (p: string) => {
      if (dirtyRef.current && !window.confirm('Discard unsaved changes?')) return
      setSelected(p)
      setLoading(true)
      setError(null)
      setPreview(false)
      try {
        const r = await fetch(`/api/agent-files?agent=${encodeURIComponent(agentId)}&path=${encodeURIComponent(p)}`)
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
        setContent(d.content)
        setSavedContent(d.content)
        setMtimeMs(typeof d.mtimeMs === 'number' ? d.mtimeMs : null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setContent('')
        setSavedContent('')
      } finally {
        setLoading(false)
      }
    },
    [agentId],
  )

  const switchAgent = useCallback((id: string) => {
    if (dirtyRef.current && !window.confirm('Discard unsaved changes?')) return
    setAgentId(id)
    setSelected(null)
    setContent('')
    setSavedContent('')
    setMtimeMs(null)
    setError(null)
  }, [])

  const save = useCallback(
    async (confirmSensitive = false) => {
      if (!selected || saving) return
      setSaving(true)
      try {
        const r = await fetch('/api/agent-files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'write', agent: agentId, path: selected, content, expectedMtimeMs: mtimeMs, confirmSensitive }),
        })
        const d = await r.json()
        if (r.status === 412 && d.code === 'confirm_required') {
          const typed = window.prompt(`${d.message}\n\nType CONFIRM to save anyway.`)
          if (typed === 'CONFIRM') {
            setSaving(false)
            return save(true)
          }
          return
        }
        if (r.status === 409) {
          toast(d.message || 'File changed on disk. Reload it first.')
          return
        }
        if (!r.ok) throw new Error(d.message || d.error || `HTTP ${r.status}`)
        setSavedContent(content)
        setMtimeMs(d.mtimeMs)
        toast(d.backup ? `Saved. Backup: ${d.backup}` : 'Saved.')
        void loadTree(agentId)
      } catch (e) {
        toast(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setSaving(false)
      }
    },
    [agentId, content, loadTree, mtimeMs, saving, selected],
  )

  // Ctrl/Cmd+S and leave guard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      }
    }
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('beforeunload', onUnload)
    }
  }, [save])

  const restart = useCallback(async () => {
    if (!window.confirm('Restart the agent now? Chats in progress will be interrupted and this UI will reload in about a minute.')) return
    setRestarting(true)
    try {
      const r = await fetch('/api/agent-files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'restart' }) })
      const d = await r.json()
      toast(d.message || (r.ok ? 'Restart requested.' : 'Restart failed.'))
    } catch (e) {
      toast(`Restart failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRestarting(false)
    }
  }, [])

  const isMarkdown = !!selected && languageFor(selected) === 'markdown'
  const isSoul = !!selected && selected.split('/').pop() === 'SOUL.md'
  const note = selected ? applyNote(selected) : null
  const chars = content.length
  const agentLabel = useMemo(() => agents.find((a) => a.id === agentId)?.label ?? agentId, [agents, agentId])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-primary-200 px-3 py-2.5 dark:border-neutral-800 md:px-4">
        <div>
          <h1 className="text-base font-semibold text-primary-900 dark:text-white">Agent Files</h1>
          <p className="text-xs text-primary-600 dark:text-neutral-400">SOUL, AGENTS, config, memories, scripts, hooks and tools — per agent, edited live on the agent home. Skills have their own page.</p>
        </div>
        <Button size="sm" variant="secondary" disabled={restarting} onClick={restart} title="Restart the agent (Coolify)">
          {restarting ? 'Restarting…' : 'Restart agent'}
        </Button>
      </header>

      <div className="flex flex-wrap gap-1 border-b border-primary-200 px-3 py-2 dark:border-neutral-800 md:px-4">
        {agents.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => switchAgent(a.id)}
            className={
              'rounded-full px-3 py-1 text-xs ' +
              (a.id === agentId
                ? 'bg-primary-900 text-white dark:bg-white dark:text-neutral-900'
                : 'bg-primary-100 text-primary-800 hover:bg-primary-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700')
            }
          >
            {a.label}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 overflow-y-auto border-r border-primary-200 py-2 dark:border-neutral-800">
          {treeLoading ? (
            <div className="px-3 py-2 text-xs text-primary-600">Loading…</div>
          ) : tree.length === 0 ? (
            <div className="px-3 py-2 text-xs text-primary-600">No editable files found for {agentLabel}.</div>
          ) : (
            <Tree nodes={tree} selected={selected} onSelect={(p) => void openFile(p)} />
          )}
        </aside>

        <section className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-primary-200 px-3 py-2 dark:border-neutral-800">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-primary-900 dark:text-white">{selected ? `${agentLabel} / ${selected}` : 'Pick a file'}</div>
              <div className="text-xs text-primary-600 dark:text-neutral-400">
                {saving ? 'Saving…' : dirty ? 'Unsaved changes' : selected ? 'Saved' : ''}
                {selected ? ` · ${chars.toLocaleString()} chars` : ''}
                {isSoul && chars > SOUL_SOFT_LIMIT ? ` · long for a SOUL (>${SOUL_SOFT_LIMIT.toLocaleString()} chars, may be truncated)` : ''}
                {note ? ` · ${note}` : ''}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isSoul && !content.trim() ? (
                <Button size="sm" variant="secondary" onClick={() => setContent(SOUL_TEMPLATE)}>
                  Insert SOUL template
                </Button>
              ) : null}
              {isMarkdown ? (
                <Button size="sm" variant="secondary" onClick={() => setPreview((p) => !p)}>
                  {preview ? 'Edit' : 'Preview'}
                </Button>
              ) : null}
              <Button size="sm" variant="secondary" disabled={!dirty || saving} onClick={() => setContent(savedContent)}>
                Revert
              </Button>
              <Button size="sm" disabled={!selected || !dirty || saving} onClick={() => void save()} title="Ctrl/Cmd+S">
                Save
              </Button>
            </div>
          </div>

          <div className="min-h-0 flex-1">
            {!selected ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-primary-600 dark:text-neutral-400">
                Choose an agent above, then a file on the left. Start with SOUL.md.
              </div>
            ) : loading ? (
              <div className="flex h-full items-center justify-center text-sm text-primary-600">Loading…</div>
            ) : error ? (
              <div className="flex h-full items-center justify-center px-6 text-sm text-red-700">{error}</div>
            ) : preview && isMarkdown ? (
              <div className="h-full overflow-y-auto px-6 py-4">
                <Markdown className="prose prose-sm max-w-3xl dark:prose-invert">{content}</Markdown>
              </div>
            ) : (
              <Editor
                height="100%"
                theme={theme === 'dark' ? 'vs-dark' : 'vs-light'}
                language={languageFor(selected)}
                path={`${agentId}/${selected}`}
                value={content}
                onChange={(v) => setContent(v || '')}
                options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: isMarkdown ? 'on' : 'off', scrollBeyondLastLine: false, lineNumbersMinChars: 3 }}
              />
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
