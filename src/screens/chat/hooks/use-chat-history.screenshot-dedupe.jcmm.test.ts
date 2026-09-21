import { describe, expect, it } from 'vitest'

import type { ChatMessage } from '../types'
import { userTextForMatch } from './use-chat-history'

const HEADER = '<workspace_context active="true" name="workspace" path="/workspace" />'

function userMessage(text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role: 'user', content: [{ type: 'text', text }], ...extra } as ChatMessage
}

describe('hermes-jcmm: a user message with an image matches its transcript row', () => {
  it('ignores the [screenshot] placeholder the agent stores for image parts', () => {
    const optimistic = userMessage('can you attach it as a file?', {
      attachments: [{ name: 'image.png', size: 1234, contentType: 'image/png' }],
    } as Partial<ChatMessage>)
    const persisted = userMessage(
      `${HEADER}\n\ncan you attach it as a file?\n[screenshot]`,
    )
    expect(userTextForMatch(optimistic)).toBe('can you attach it as a file?')
    expect(userTextForMatch(persisted)).toBe('can you attach it as a file?')
  })

  it('keeps ordinary text intact', () => {
    expect(userTextForMatch(userMessage('  plain   text  '))).toBe('plain text')
  })
})
