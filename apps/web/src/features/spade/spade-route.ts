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

/**
 * Whether a window's connection is the desktop app's own daemon, the one beside the Spade the
 * app reaches directly: both identities known, and the same. A window showing another machine
 * (through an account relay or Connect) must reach that machine's Spade, through its daemon.
 */
export function isLocalMachine(
  spadeHost: string | undefined,
  connectedHost: string | undefined,
): boolean {
  return spadeHost !== undefined && spadeHost === connectedHost;
}

/** After a look: up when the app knows a Spade it speaks to, beside this window's daemon. */
export function afterLook(found: boolean, now: number): DirectRoute {
  return found ? { state: "up" } : { state: "down", at: now };
}

/** A direct request or stream found nobody listening: the daemon carries on for a while. */
export function afterUnreachable(now: number): DirectRoute {
  return { state: "down", at: now };
}

/** What the app's direct look at Spade's `/health` found; undefined until it looked. */
export type DirectHealth = { ready: true; version: string | undefined } | { ready: false };

/** What the screens say while the app's own look at Spade finds nobody answering. */
export const unreachableReason = "Spade isn't reachable.";

/**
 * Spade's status for the screens: ready whenever Spade answers its `/health` directly, even
 * while the daemon is down or hasn't said. A direct look that found nobody overrides the
 * daemon's last ready (it may be stale): Spade isn't reachable. Otherwise what the daemon says.
 * The unreachable status is `off` with a reason, so the screens show that one sentence and
 * offer no switch.
 */
export function spadeStatusWith(
  daemon: SpadeStatus | undefined,
  direct: DirectHealth | undefined,
): SpadeStatus | undefined {
  if (direct?.ready === false && daemon?.state === "ready")
    return { state: "off", reason: unreachableReason };
  if (!direct?.ready) return daemon;
  const version = direct.version ?? daemon?.version;
  return {
    state: "ready",
    ...(version === undefined ? {} : { version }),
    ...(daemon?.thread ? { thread: daemon.thread } : {}),
    // What Spade is still waiting on is only known from the daemon's look.
    ...(daemon?.state === "ready" && daemon.setup ? { setup: daemon.setup } : {}),
  };
}

/**
 * The daemon's last word once its connection is gone: a ready it reported may no longer hold,
 * so it stops counting until the daemon says again; anything else stands.
 */
export function daemonStatusWhileAway(status: SpadeStatus | undefined): SpadeStatus | undefined {
  return status?.state === "ready" ? undefined : status;
}
