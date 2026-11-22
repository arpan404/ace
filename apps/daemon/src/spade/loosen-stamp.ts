import { createHash } from "node:crypto";
import { spadeLooseningRoute } from "@ace/client/spade-person-only";

/*
 * Changes that may loosen what a bot may do (ADR 0171, amendment 7): moving its commands outside
 * the sandbox, widening a network policy or following a wider default, adding a grant, letting it
 * use more connected apps, turning a package's effect on. Only Spade can tell whether a change
 * loosens (it knows what holds now), so the daemon stamps each as the person's when the caller
 * proved their standing, over the bytes it forwards, and otherwise forwards it unstamped: Spade
 * then makes it only if it tightens. Pure.
 */

/** A loosening change: the bot (or `machine`) it is for, and what the stamp signs. */
export interface LooseningWrite {
  target: string;
  value: string;
  /** Forwarded unstamped when the caller hasn't proved standing; Spade decides. */
  optional: true;
}

/** The target and stamp word of a loosening change, from its route alone (shared with the app). */
export const looseningRoute = spadeLooseningRoute;

/** The stamp's target and value for a loosening change with `body`, over its SHA-256. */
export function looseningWrite(
  method: string,
  path: string,
  body: Buffer | undefined,
): LooseningWrite | undefined {
  const route = looseningRoute(method, path);
  if (!route) return undefined;
  const value = route.inherit
    ? `${route.word}:inherit`
    : `${route.word}:${createHash("sha256")
        .update(body ?? Buffer.alloc(0))
        .digest("hex")}`;
  return { target: route.target, value, optional: true };
}
