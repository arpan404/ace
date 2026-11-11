import type { SpadeStatus } from "@ace/protocol";

/*
 * Which way a request to Spade goes in the desktop app (ADR 0123), with no I/O: straight to
 * Spade through the app's main process when it knows a Spade on this computer, else through
 * the daemon's `spade.*` family. A direct request that finds nobody listening falls back to
 * the daemon, which then carries requests until the next look.
 */

export type DirectRoute =
  /** Not looked yet, or Spade's files changed since. */
  | { state: "unknown" }
  | { state: "up" }
  /** No Spade known, or the last direct request found nobody listening, at `at`. */
  | { state: "down"; at: number };

/** How long the daemon carries requests before the app looks for Spade again. */
export const recheckMs = 5_000;

export type SpadePath = "direct" | "daemon" | "look";

/** Where the next request goes; `look`: ask the app for Spade's endpoint first. */
export function spadePath(route: DirectRoute, now: number): SpadePath {
  if (route.state === "up") return "direct";
  if (route.state === "unknown" || now - route.at >= recheckMs) return "look";
  return "daemon";
}

/** After a look: up when the app knows a Spade it speaks to. */
export function afterLook(found: boolean, now: number): DirectRoute {
  return found ? { state: "up" } : { state: "down", at: now };
}

/** A direct request or stream found nobody listening: the daemon carries on for a while. */
export function afterUnreachable(now: number): DirectRoute {
  return { state: "down", at: now };
}

/** What the app's direct look at Spade's `/health` found; undefined until it looked. */
export type DirectHealth = { ready: true; version: string | undefined } | { ready: false };

/**
 * Spade's status for the screens: ready whenever Spade answers its `/health` directly, even
 * while the daemon is down or hasn't said; otherwise what the daemon says.
 */
export function spadeStatusWith(
  daemon: SpadeStatus | undefined,
  direct: DirectHealth | undefined,
): SpadeStatus | undefined {
  if (!direct?.ready) return daemon;
  const version = direct.version ?? daemon?.version;
  return {
    state: "ready",
    ...(version === undefined ? {} : { version }),
    ...(daemon?.thread ? { thread: daemon.thread } : {}),
  };
}
