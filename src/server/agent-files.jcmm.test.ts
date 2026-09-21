import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-af-'))
process.env.HERMES_HOME = home
const m = await import('./agent-files')

function w(rel: string, content: string) {
  const abs = path.join(home, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

beforeAll(() => {
  w('SOUL.md', 'You are root.\n')
  w('config.yaml', 'approvals:\n  mode: smart\nmodel:\n  default: x\n')
  w('.env', 'secret\n')
  w('credentials/x', 'nope')
  w('scripts/x.sh', 'echo hi\n')
  w('profiles/comms/SOUL.md', '# comms\n')
  w('profiles/comms/memories/MEMORY.md', 'note\n')
})

describe('agent-files (hermes-jcmm)', () => {
  it('lists agents and files, denies secrets and traversal', () => {
    expect(m.listAgents().map((a) => a.id)).toEqual(['root', 'comms'])
    const paths = JSON.stringify(m.listAgentFiles('root').tree)
    expect(paths).toContain('SOUL.md')
    expect(paths).toContain('scripts')
    expect(paths).not.toContain('.env')
    expect(paths).not.toContain('credentials')
    expect(() => m.readAgentFile('root', '.env')).toThrow()
    expect(() => m.readAgentFile('root', '../etc/passwd')).toThrow()
    expect(() => m.readAgentFile('root', 'credentials/x')).toThrow()
    expect(m.readAgentFile('comms', 'memories/MEMORY.md').content).toBe('note\n')
  })
  it('writes with backup, validates yaml, gates sensitive keys, detects conflicts', () => {
    expect(m.writeAgentFile('root', 'SOUL.md', 'You are new.\n').ok).toBe(true)
    expect(fs.readdirSync(home).some((n) => n.startsWith('SOUL.md.bak-'))).toBe(true)
    expect(fs.readFileSync(path.join(home, 'SOUL.md'), 'utf8')).toBe('You are new.\n')
    const bad = m.writeAgentFile('root', 'config.yaml', 'approvals: [unclosed\n')
    expect(bad.ok === false && bad.code === 'invalid').toBe(true)
    const sens = m.writeAgentFile('root', 'config.yaml', 'approvals:\n  mode: off\nmodel:\n  default: x\n')
    expect(sens.ok === false && sens.code === 'confirm_required').toBe(true)
    expect(m.writeAgentFile('root', 'config.yaml', 'approvals:\n  mode: off\nmodel:\n  default: x\n', { confirmSensitive: true }).ok).toBe(true)
    const stale = m.writeAgentFile('root', 'SOUL.md', 'x', { expectedMtimeMs: 1 })
    expect(stale.ok === false && stale.code === 'conflict').toBe(true)
    expect(() => m.writeAgentFile('root', 'random/x.md', 'x')).toThrow()
  })
})
