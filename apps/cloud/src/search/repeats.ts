/**
 * The same query asked again and again (ADR 0210 §4): the third identical query from an account
 * within a minute is refused. Best effort: it lives in this isolate's memory, so requests that
 * land on other isolates or locations aren't seen together. It is a cheap abuse signal, never a
 * limit: every limit that must hold is a D1 counter (counters.ts).
 *
 * It holds only a SHA-256 digest of a random salt made for this isolate, the account and the
 * normalized query: never stored, never logged, gone within a minute.
 */

export const REPEAT_WINDOW_MS = 60_000;
/** How many identical queries a minute pass; the next is refused. */
export const REPEATS_ALLOWED = 2;
/** The most digests held at once; the oldest go first. */
const MOST_HELD = 10_000;

export function repeatGuard(deps: { now: () => number; salt: Uint8Array }) {
  const held = new Map<string, number[]>();
  const salt = Array.from(deps.salt, (byte) => byte.toString(16).padStart(2, "0")).join("");

  async function key(account: string, query: string): Promise<string> {
    const normalized = query.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
    const bytes = new TextEncoder().encode(`${salt}\n${account}\n${normalized}`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  return {
    /** Records this query; true when it was already asked too often in the last minute. */
    async repeated(account: string, query: string): Promise<boolean> {
      const now = deps.now();
      const id = await key(account, query);
      const recent = (held.get(id) ?? []).filter((at) => now - at < REPEAT_WINDOW_MS);
      if (recent.length >= REPEATS_ALLOWED) {
        held.set(id, recent);
        return true;
      }
      recent.push(now);
      held.delete(id);
      held.set(id, recent);
      while (held.size > MOST_HELD) {
        const oldest = held.keys().next().value;
        if (oldest === undefined) break;
        held.delete(oldest);
      }
      return false;
    },
  };
}
export type RepeatGuard = ReturnType<typeof repeatGuard>;
