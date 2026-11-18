import { MachineFailure, type MachineTransport } from "./transport.ts";

/** Machine calls through a relay (ADR 0182), with the same answers and failures as direct ones. */
export interface RelayCalls {
  call: MachineTransport;
  /** The relay answered for this machine lately, so it goes first. */
  prefers(profile: Parameters<MachineTransport>[0]): boolean;
}

/** Nothing reached the machine: sending it again elsewhere can't run it twice. */
function neverSent(error: unknown): boolean {
  return error instanceof MachineFailure && error.kind === "offline";
}

/**
 * Machine calls by whichever path reaches the machine (ADR 0182): its pinned TLS address, or
 * a relay when that call was never sent there. Work is never sent twice: a call that may have
 * reached the machine on one path (`disconnected`, a timeout after connecting, a refusal) is
 * never tried on the other. The path that answered lately goes first, so a machine reachable
 * only through a relay isn't waited on at a dead address on every call.
 */
export function withRelayFallback(
  direct: MachineTransport,
  relay: () => RelayCalls | undefined,
): MachineTransport {
  return async (profile, body, options) => {
    const calls = relay();
    const [first, second] =
      calls && calls.prefers(profile) ? [calls.call, direct] : [direct, calls?.call];
    try {
      return await first(profile, body, options);
    } catch (error) {
      if (!second || !neverSent(error) || options.signal?.aborted) throw error;
      return second(profile, body, options);
    }
  };
}
