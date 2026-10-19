/*
 * Which server messages may be compressed on the way to a remote client.
 *
 * Compressing before encryption lets a message's length leak what it holds when a secret and
 * data an attacker controls share one compression context (CRIME, BREACH). So:
 *
 * - every message is compressed on its own: no context carries over from one message to the
 *   next (per-message deflate without context takeover, or a fresh deflate per relayed message);
 * - only the bulk streams below are compressed at all. None of them carries an ace credential
 *   (device tokens, tickets, pairing codes, sign-in links and codes, preview session links,
 *   cookies ace holds); messages that can carry one are never compressed;
 * - frames, screen packets and file bytes are already compressed and go as they are.
 *
 * An allowlist, so a new message type stays uncompressed until someone decides it is safe.
 */
const compressible = new Set<string>([
  "events",
  "snapshot",
  "snapshot.part",
  "entities.page",
  "entities.page.part",
  "items.page",
  "items.window",
  "turns.page",
  "turn.steps",
  "threads.patch",
  "thread.catchUp",
  "thread.search",
  "search.results",
  "history.list",
  "catalog.changed",
  "catalog.list.result",
  "browser.state",
  "browser.annotation",
  "browser.browsing",
  "browser.backend.lost",
  "devices.state",
  "devices.inventory",
  "screen.state",
  "preview.suggestions",
  "models.result",
  "projects.result",
  "repositories.result",
  "workspace.result",
  "source-control.result",
  "usage.result",
]);

/** Smaller messages gain too little to be worth a deflate. */
export const compressionThresholdBytes = 1024;

/** Whether a JSON server message of this type may be compressed (alone) for a remote peer. */
export function mayCompress(type: string): boolean {
  return compressible.has(type);
}

/**
 * Per-message deflate for the daemon's remote listener: each message alone (no context takeover
 * in either direction), small ones as they are. The local listener doesn't compress: loopback
 * bytes cost nothing and deflate costs CPU.
 */
export const remoteDeflate = {
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  threshold: compressionThresholdBytes,
  concurrencyLimit: 10,
  zlibDeflateOptions: { level: 6, memLevel: 8 },
} as const;
