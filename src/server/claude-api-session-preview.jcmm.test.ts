import { describe, expect, it } from 'vitest'

import { stripWorkspaceDirectivePreview, toSessionSummary } from './claude-api'

const HEADER = '<workspace_context active="true" name="workspace" path="/workspace" />'

describe('hermes-jcmm: session preview never shows the workspace_context header', () => {
  it('strips a full header', () => {
    expect(stripWorkspaceDirectivePreview(`${HEADER}\n\nFix the sidebar`)).toBe(
      'Fix the sidebar',
    )
  })

  it('strips the truncated, unclosed header the dashboard returns', () => {
    expect(
      stripWorkspaceDirectivePreview('<workspace_context active="true" name="workspace" path="/wor'),
    ).toBeUndefined()
  })

  it('leaves ordinary previews alone', () => {
    expect(stripWorkspaceDirectivePreview('The chat titling is broken')).toBe(
      'The chat titling is broken',
    )
  })

  it('derivedTitle falls back to the cleaned preview, never the header', () => {
    const summary = toSessionSummary({
      id: 'abc',
      title: null,
      preview: `${HEADER} Rename the file`,
    } as never)
    expect(summary.derivedTitle).toBe('Rename the file')
    expect(summary.preview).toBe('Rename the file')
  })
})
