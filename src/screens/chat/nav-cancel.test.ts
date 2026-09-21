import { describe, expect, it } from 'vitest'

import { buildNavKey, shouldCancelStreamOnNav } from './nav-cancel'

const SESSION = 'bbb85411-dd23-4561-9129-06533cfdf286'

describe('hermes-jcmm: cancel-on-navigation guard', () => {
  it('does nothing on first render', () => {
    expect(
      shouldCancelStreamOnNav({
        previousNavKey: null,
        navKey: buildNavKey(null, true, 'new'),
        isNewChat: true,
        activeFriendlyId: 'new',
        activeCanonicalKey: null,
        activeSend: null,
      }),
    ).toBe(false)
  })

  it('does not cancel when the key is unchanged', () => {
    const key = buildNavKey(SESSION, false, SESSION)
    expect(
      shouldCancelStreamOnNav({
        previousNavKey: key,
        navKey: key,
        isNewChat: false,
        activeFriendlyId: SESSION,
        activeCanonicalKey: SESSION,
        activeSend: null,
      }),
    ).toBe(false)
  })

  it('keeps the stream when a new chat resolves to its own session id', () => {
    // /chat/new -> /chat/<id>: the send already learned its session from
    // the gateway (onSessionResolved), so this key change is not a navigation.
    expect(
      shouldCancelStreamOnNav({
        previousNavKey: buildNavKey(null, true, 'new'),
        navKey: buildNavKey(null, false, SESSION),
        isNewChat: false,
        activeFriendlyId: SESSION,
        activeCanonicalKey: null,
        activeSend: { sessionKey: SESSION, friendlyId: SESSION },
      }),
    ).toBe(false)
    // …and again when the canonical key resolves a few seconds later.
    expect(
      shouldCancelStreamOnNav({
        previousNavKey: buildNavKey(null, false, SESSION),
        navKey: buildNavKey(SESSION, false, SESSION),
        isNewChat: false,
        activeFriendlyId: SESSION,
        activeCanonicalKey: SESSION,
        activeSend: { sessionKey: SESSION, friendlyId: SESSION },
      }),
    ).toBe(false)
  })

  it('cancels when the user really navigates to another session', () => {
    expect(
      shouldCancelStreamOnNav({
        previousNavKey: buildNavKey(SESSION, false, SESSION),
        navKey: buildNavKey('other', false, 'other'),
        isNewChat: false,
        activeFriendlyId: 'other',
        activeCanonicalKey: 'other',
        activeSend: { sessionKey: SESSION, friendlyId: SESSION },
      }),
    ).toBe(true)
  })

  it('cancels when the user opens a new chat while a stream runs', () => {
    expect(
      shouldCancelStreamOnNav({
        previousNavKey: buildNavKey(SESSION, false, SESSION),
        navKey: buildNavKey(null, true, 'new'),
        isNewChat: true,
        activeFriendlyId: 'new',
        activeCanonicalKey: null,
        activeSend: { sessionKey: SESSION, friendlyId: SESSION },
      }),
    ).toBe(true)
  })

  it('cancels a key change with no send of our own in flight', () => {
    expect(
      shouldCancelStreamOnNav({
        previousNavKey: buildNavKey('a', false, 'a'),
        navKey: buildNavKey('b', false, 'b'),
        isNewChat: false,
        activeFriendlyId: 'b',
        activeCanonicalKey: 'b',
        activeSend: null,
      }),
    ).toBe(true)
  })
})
