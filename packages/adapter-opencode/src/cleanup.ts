import type { SessionOwnership } from "./ownership.ts";
import type { OpenCodeServer } from "./server.ts";
/** Session closure is bounded; only verified owners receive cleanup commands. */
export async function cleanupOwned(
  server: OpenCodeServer,
  ownership: SessionOwnership,
): Promise<void> {
  if (!ownership.root) return;
  const controller = new AbortController();
  const cancel = server.runtime.schedule(() => controller.abort(), server.shutdownTimeoutMs);
  try {
    for (const [id, owner] of ownership.shells) {
      const directory = ownership.sessions.get(owner)?.directory;
      if (!directory) continue;
      const client = server.scoped(directory, () => {}, controller.signal);
      await client.shell.remove({ id, location: { directory } }).catch(() => {});
    }
    for (const sessionID of ownership.descendants(ownership.root).concat(ownership.root)) {
      controller.signal.throwIfAborted();
      const directory = ownership.sessions.get(sessionID)?.directory;
      if (!directory) continue;
      await server
        .scoped(directory, () => {}, controller.signal)
        .session.interrupt({ sessionID })
        .catch(() => {});
    }
  } catch {
    // The last owned server lease still stops the process through provider-kit.
    // External attachment never gains process ownership, even when cleanup fails.
  } finally {
    cancel();
    controller.abort();
  }
}
