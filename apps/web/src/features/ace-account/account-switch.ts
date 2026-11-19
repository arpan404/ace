import type { AceAccountState } from "./session-store.ts";

/**
 * Calls `left` each time the window stops being signed in to an account it was signed in to:
 * signed out, the session ended (401), or another account signed in. Signing in from signed
 * out, or the same account's session refreshing, calls nothing. Returns the unsubscribe.
 */
export function followAccountLeaving(
  store: { get(): AceAccountState; subscribe(listener: () => void): () => void },
  left: (accountId: string) => void,
): () => void {
  let current = store.get().session?.account.id;
  return store.subscribe(() => {
    const next = store.get().session?.account.id;
    if (next === current) return;
    const previous = current;
    current = next;
    if (previous !== undefined) left(previous);
  });
}
