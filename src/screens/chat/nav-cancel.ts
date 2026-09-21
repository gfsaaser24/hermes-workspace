// hermes-jcmm: the "cancel the in-flight stream when the user navigates to
// another session" guard (#297) also fired on the FIRST message of a new chat:
// the send resolves /chat/new -> /chat/<id>, the route key changes, and the
// stream that just started was aborted (Stop button + thinking indicator
// vanished ~5s in, tool cards only came back after a reload). The stream's
// own session is never "navigated away from".

export type ActiveSend = {
  sessionKey: string
  friendlyId: string
}

export type NavCancelInput = {
  previousNavKey: string | null
  navKey: string
  isNewChat: boolean
  activeFriendlyId: string
  activeCanonicalKey: string | null | undefined
  activeSend: ActiveSend | null
}

export function buildNavKey(
  activeCanonicalKey: string | null | undefined,
  isNewChat: boolean,
  activeFriendlyId: string,
): string {
  return `${activeCanonicalKey ?? ''}::${isNewChat ? 'new' : activeFriendlyId}`
}

export function streamBelongsToActiveSession(
  activeSend: ActiveSend | null,
  isNewChat: boolean,
  activeFriendlyId: string,
  activeCanonicalKey: string | null | undefined,
): boolean {
  if (!activeSend || isNewChat) return false
  const ids = new Set([activeSend.sessionKey, activeSend.friendlyId].filter(Boolean))
  if (ids.has(activeFriendlyId)) return true
  return Boolean(activeCanonicalKey && ids.has(activeCanonicalKey))
}

/** True when the key change is a real navigation and the stream must be cancelled. */
export function shouldCancelStreamOnNav(input: NavCancelInput): boolean {
  if (input.previousNavKey === null) return false
  if (input.previousNavKey === input.navKey) return false
  return !streamBelongsToActiveSession(
    input.activeSend,
    input.isNewChat,
    input.activeFriendlyId,
    input.activeCanonicalKey,
  )
}
