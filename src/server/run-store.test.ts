import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalHermesHome = process.env.HERMES_HOME

let tempHome: string | null = null

beforeEach(() => {
  vi.resetModules()
  tempHome = mkdtempSync(join(tmpdir(), 'hermes-run-store-'))
  process.env.HERMES_HOME = tempHome
})

afterEach(() => {
  if (tempHome) rmSync(tempHome, { recursive: true, force: true })
  tempHome = null
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  vi.resetModules()
})

describe('run-store persistence', () => {
  it('preserves concurrent updates to the same run', async () => {
    const { addRunLifecycleEvent, createPersistedRun, getPersistedRun } =
      await import('./run-store')

    await createPersistedRun({ runId: 'run-1', sessionKey: 'session-1' })

    const events = Array.from({ length: 24 }, (_, index) => ({
      text: `event-${index}`,
      emoji: '',
      timestamp: index,
      isError: false,
    }))

    await Promise.all(
      events.map((event) => addRunLifecycleEvent('session-1', 'run-1', event)),
    )

    const stored = await getPersistedRun('session-1', 'run-1')
    expect(stored?.lifecycleEvents.map((event) => event.text).sort()).toEqual(
      events.map((event) => event.text).sort(),
    )
  })
  it('keeps a user Stop final when the upstream abort reports an error afterwards', async () => {
    const { createPersistedRun, getPersistedRun, markRunStatus } =
      await import('./run-store')
    await createPersistedRun({ runId: 'run-stop', sessionKey: 'session-1' })
    await markRunStatus('session-1', 'run-stop', 'stopped')
    // send-stream's catch on the abort we just triggered
    await markRunStatus('session-1', 'run-stop', 'error', 'This operation was aborted')
    const stored = await getPersistedRun('session-1', 'run-stop')
    expect(stored?.status).toBe('stopped')
    expect(stored?.errorMessage).toBeUndefined()
  })

  it('keeps a quiet run re-attachable while this process still owns it', async () => {
    // A single long tool call writes nothing for > 5 min; the run is still
    // alive as long as its upstream stream is open in this process.
    const { createPersistedRun, getActiveRunForSession, markRunStatus } =
      await import('./run-store')
    await createPersistedRun({ runId: 'run-long', sessionKey: 'session-1' })
    await markRunStatus('session-1', 'run-long', 'active')
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 6 * 60 * 1000)
      expect(await getActiveRunForSession('session-1')).toBeNull()
      const owned = await getActiveRunForSession('session-1', {
        isOwned: (runId) => runId === 'run-long',
      })
      expect(owned?.runId).toBe('run-long')
    } finally {
      vi.useRealTimers()
    }
  })
})
