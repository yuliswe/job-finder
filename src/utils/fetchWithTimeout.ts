/** `fetch` wrapper that aborts the request when `timeoutMs` elapses.
 * The repo's `no-restricted-globals` rule forbids the raw `fetch` global —
 * use this helper instead so timeouts are uniformly enforced and the
 * disable lives in one place.
 *
 * On timeout the AbortController fires and the underlying `fetch` rejects
 * with a `DOMException` whose `name === 'AbortError'`. Callers can detect
 * that to differentiate timeouts from other network failures.
 *
 * Note: if `init.signal` is also provided, it is ignored — the helper
 * owns the signal so timeouts work. If you need both, compose with
 * `AbortSignal.any([yourSignal, controller.signal])` at the callsite. */
export async function fetchWithTimeout(
  input: string | URL,
  init: Omit<RequestInit, 'signal'> & { timeoutMs: number }
): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // eslint-disable-next-line no-restricted-globals
    return await fetch(input, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
