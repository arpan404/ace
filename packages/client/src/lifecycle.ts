import { ClientError, type ConnectionState } from "./types.ts";

export function retryDelay(attempt: number, base: number, cap: number, random: number): number {
  if (!Number.isFinite(random) || random < 0 || random >= 1)
    throw new ClientError("protocol", "Random sample must be in [0, 1)");
  return Math.min(cap, base * 2 ** Math.min(attempt, 30)) * random;
}
export function disconnectDecision(
  active: boolean,
  online: boolean,
  code: number,
): "fatal" | "offline" | "reconnecting" {
  if (code === 4001) return "fatal";
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
