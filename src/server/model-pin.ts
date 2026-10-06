/**
 * Deployment-wide model pin (hermes-jcmm, 2026-10-06).
 *
 * When `HERMES_WORKSPACE_PIN_MODEL` is set, the workspace offers, shows and
 * sends only that model id. Stale per-chat picks (browser localStorage,
 * the in-memory local session store, old session rows) can no longer leak
 * another model into the picker or a chat request.
 */
export function getPinnedModel(): string {
  return (process.env.HERMES_WORKSPACE_PIN_MODEL ?? '').trim()
}

/** The pinned model when a pin is set, else the caller's requested value. */
export function applyModelPin(requested: unknown): unknown {
  const pinned = getPinnedModel()
  return pinned || requested
}

/** Rewrite `payload.model` (and top-level `model`) in a status-like JSON body. */
export function pinModelInStatusBody<T>(data: T): T {
  const pinned = getPinnedModel()
  if (!pinned || !data || typeof data !== 'object') return data
  const record = data as Record<string, unknown>
  if (typeof record.model === 'string') record.model = pinned
  const payload = record.payload
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    ;(payload as Record<string, unknown>).model = pinned
  }
  return data
}
