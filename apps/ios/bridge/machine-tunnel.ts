import { loopbackProblemOf, type LoopbackProblem } from "@ace/ui-core/device-loopback";
export type { MachineTunnel, TunnelStream } from "@ace/client/machine-tunnel";

/** The problem a refused `open` names; anything uncoded reads as the machine being offline. */
export function tunnelRefusal(error: unknown): LoopbackProblem {
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" ? loopbackProblemOf(code) : "offline";
}
