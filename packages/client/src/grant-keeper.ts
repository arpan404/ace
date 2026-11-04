import { grantLifetimeMs } from "@ace/account-grant";
import type { ClientMessage } from "@ace/protocol";
import type { Scheduler } from "./types.ts";

const noop = () => {};
/** How long before a grant runs out the client sends the next one. */
export const GRANT_REFRESH_LEAD_MS = 60_000;
/** After a grant fetch fails, how long until the next try. */
export const GRANT_RETRY_MS = 10_000;

/**
 * When to refresh a socket's grant that has `ttlMs` left: a lead before it runs out, or halfway
 * there for a grant shorter than two leads. Pure.
 */
export function grantRefreshDelay(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return 0;
  return ttlMs > 2 * GRANT_REFRESH_LEAD_MS ? ttlMs - GRANT_REFRESH_LEAD_MS : Math.floor(ttlMs / 2);
}

/**
 * Keep one account socket's grant fresh (ADR 0111, ADR 0114): before it runs out, fetch a new
 * device grant and send it on the same socket as `account.grant.refresh`. The next refresh is
 * timed from the new grant's own lifetime. A failed fetch tries again shortly; if none lands in
 * time the daemon closes the socket and the connection reconnects as after any drop. Returns
 * a stop function; call it when the socket ends.
 */
export function keepGrant(options: {
  /** What the welcome said the socket's grant has left. */
  ttlMs: number;
  grant(): Promise<string>;
  send(message: ClientMessage): void;
  scheduler: Scheduler;
  id(): string;
}): () => void {
  let stopped = false;
  let cancel: () => void = noop;
  const schedule = (delayMs: number) => {
    cancel = options.scheduler.set(delayMs, refresh);
  };
  const refresh = () => {
    if (stopped) return;
    options.grant().then(
      (grant) => {
        if (stopped) return;
        try {
          options.send({ type: "account.grant.refresh", requestId: options.id(), grant });
        } catch {
          // The socket is going; its close stops this keeper.
          return;
        }
        const lifetime = grantLifetimeMs(grant);
        schedule(lifetime === undefined ? GRANT_RETRY_MS : grantRefreshDelay(lifetime));
      },
      () => {
        if (!stopped) schedule(GRANT_RETRY_MS);
      },
    );
  };
  schedule(grantRefreshDelay(options.ttlMs));
  return () => {
    stopped = true;
    cancel();
  };
}
