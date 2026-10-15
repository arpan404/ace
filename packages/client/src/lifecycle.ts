import { ClientError, type ConnectionState } from "./types.ts";

export function retryDelay(attempt: number, base: number, cap: number, random: number): number {
  if (!Number.isFinite(random) || random < 0 || random >= 1)
    throw new ClientError("protocol", "Random sample must be in [0, 1)");
  return Math.min(cap, base * 2 ** Math.min(attempt, 30)) * random;
}
/**
 * Only a refusal that another attempt can't change is fatal: the daemon rejected the
 * credential (4001) or revoked the device (4003), or the transport got a frame that is
 * neither text nor binary (4002, raised locally). Everything else, including 1009 (a frame
 * too large) and server frames the client can't read, reconnects with backoff.
 */
export function disconnectDecision(
  active: boolean,
  online: boolean,
  code: number,
): "fatal" | "offline" | "reconnecting" {
  if (code === 4001 || code === 4003 || code === 4002) return "fatal";
  return active && online ? "reconnecting" : "offline";
}
export function networkDecision(
  state: ConnectionState,
  active: boolean,
  previous: boolean,
  online: boolean,
): "none" | "connect" | "offline" {
  if (previous === online || !active || state === "fatal") return "none";
  return online ? "connect" : "offline";
}
