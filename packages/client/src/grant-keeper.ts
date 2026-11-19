import { grantLifetimeMs } from "@ace/account-grant";
import type { ClientMessage, ServerMessage } from "@ace/protocol";
import type { Scheduler } from "./types.ts";

const noop = () => {};
/** How long before a grant runs out the client sends the next one. */
export const GRANT_REFRESH_LEAD_MS = 60_000;
/**
 * After a grant fetch fails, a refresh is refused, or its answer doesn't come, how long until
 * the next try; also how long an answer may take.
 */
export const GRANT_RETRY_MS = 10_000;
/** The daemon's close of an account socket whose grant ran out: not final, the client reconnects. */
export const GRANT_EXPIRED_CLOSE = 4014;

/**
 * The daemon's close of every account socket when the account's access changed (signed out,
 * another account, a new machine code): not final, the next hello learns why.
 */
export const ACCESS_CHANGED_CLOSE = 4012;

export type GrantRefreshResult = Extract<ServerMessage, { type: "account.grant.refresh.result" }>;

/**
 * When to refresh a socket's grant that has `ttlMs` left: a lead before it runs out, or halfway
 * there for a grant shorter than two leads. Pure.
 */
export function grantRefreshDelay(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return 0;
  return ttlMs > 2 * GRANT_REFRESH_LEAD_MS ? ttlMs - GRANT_REFRESH_LEAD_MS : Math.floor(ttlMs / 2);
}

/**
 * Whether a refused refresh is final: the device needs the machine code, or the machine no
 * longer takes this account's grants. Trying again can't help; a new hello learns why. The
 * daemon also says `unauthorized` when it briefly couldn't check a grant, so that is final only
 * when the refresh before was refused the same way (`previous`). Pure.
 */
export function refreshRefusalIsFinal(code: string, previous?: string): boolean {
  if (code.startsWith("machine_code_")) return true;
  return code === "unauthorized" && previous === "unauthorized";
}

export interface GrantKeeper {
  /** The daemon answered a refresh sent on this socket; others' answers are ignored. */
  answered(message: GrantRefreshResult): void;
  /** The socket ended: send nothing more. */
  stop(): void;
}

/**
 * Keep one account socket's grant fresh (ADR 0111, ADR 0114): before it runs out, fetch a new
 * device grant and send it on the same socket as `account.grant.refresh`. The next refresh is
 * timed from the shorter of the new grant's own lifetime and what the daemon says the socket
 * now has (`grantTtlMs`, on the daemon's clock), so neither clock has to agree with the
 * backend's. A failed fetch, a refused refresh or a missing answer tries again shortly; a final
 * refusal (`refreshRefusalIsFinal`) stops and calls `refused`. If none lands in time the daemon
 * closes the socket and the connection reconnects as after any drop.
 */
export function keepGrant(options: {
  /** What the welcome said the socket's grant has left. */
  ttlMs: number;
  grant(): Promise<string>;
  send(message: ClientMessage): void;
  scheduler: Scheduler;
  id(): string;
  /** A refresh was refused for good (`code`): hand the socket to the normal refusal flow. */
  refused?(code: string): void;
}): GrantKeeper {
  let stopped = false;
  let cancel: () => void = noop;
  /** The refresh waiting for its answer, and the lifetime of the grant it carried. */
  let pending: { id: string; lifetimeMs: number | undefined } | undefined;
  /** Why the last answered refresh was refused, if it was. */
  let lastRefusal: string | undefined;
  const schedule = (delayMs: number) => {
    cancel();
    cancel = options.scheduler.set(delayMs, refresh);
  };
  const refresh = () => {
    if (stopped) return;
    pending = undefined;
    options.grant().then(
      (grant) => {
        if (stopped) return;
        const id = options.id();
        try {
          options.send({ type: "account.grant.refresh", requestId: id, grant });
        } catch {
          // The socket is going; its close stops this keeper.
          return;
        }
        pending = { id, lifetimeMs: grantLifetimeMs(grant) };
        // No answer in time: try again with a fresh grant.
        schedule(GRANT_RETRY_MS);
      },
      () => {
        if (!stopped) schedule(GRANT_RETRY_MS);
      },
    );
  };
  schedule(grantRefreshDelay(options.ttlMs));
  return {
    answered(message) {
      if (stopped || message.requestId !== pending?.id) return;
      const { lifetimeMs } = pending;
      pending = undefined;
      const { result } = message;
      const previous = lastRefusal;
      lastRefusal = result.ok ? undefined : result.code;
      if (result.ok) {
        const ttlMs =
          lifetimeMs === undefined ? result.grantTtlMs : Math.min(result.grantTtlMs, lifetimeMs);
        schedule(grantRefreshDelay(ttlMs));
        return;
      }
      if (refreshRefusalIsFinal(result.code, previous)) {
        stopped = true;
        cancel();
        options.refused?.(result.code);
        return;
      }
      schedule(GRANT_RETRY_MS);
    },
    stop() {
      stopped = true;
      cancel();
    },
  };
}
