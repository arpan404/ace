import {
  MachineFailure,
  MachineNotSent,
  MachineUnpaired,
  type MachineTransport,
} from "./transport.ts";

/** Machine calls through a relay (ADR 0182), with the same answers and failures as direct ones. */
export interface RelayCalls {
  call: MachineTransport;
  /** The relay answered for this machine lately, so it goes first. */
  prefers(profile: Parameters<MachineTransport>[0]): boolean;
}

/** The machine has no relay to try: the first path's failure stands as it was. */
export class NoRelayRoute extends MachineNotSent {}

/**
 * Nothing reached the machine, so sending it again elsewhere can't run it twice. A call held
 * back because its pairing is gone is never sent anywhere.
 */
function neverSent(error: unknown): boolean {
  return (
    error instanceof MachineFailure &&
    error.kind === "offline" &&
    !(error instanceof MachineUnpaired)
  );
}

/**
 * Machine calls by whichever path reaches the machine (ADR 0182): its pinned TLS address, or
 * a relay when that call was never sent there. Work is never sent twice: a call that may have
 * reached the machine on one path (`disconnected`, a timeout after connecting, a refusal) is
 * never tried on the other. The path that answered lately goes first, so a machine reachable
 * only through a relay isn't waited on at a dead address on every call. The second path gets
 * only what is left of the call's timeout, and when it has nothing to try the first path's
 * failure stands unchanged.
 */
export function withRelayFallback(
  direct: MachineTransport,
  relay: () => RelayCalls | undefined,
  now: () => number,
): MachineTransport {
  return async (profile, body, options) => {
    const calls = relay();
    const [first, second] =
      calls && calls.prefers(profile) ? [calls.call, direct] : [direct, calls?.call];
    const startedAt = now();
    try {
      return await first(profile, body, options);
    } catch (error) {
      if (!second || !neverSent(error) || options.signal?.aborted) throw error;
      const left = options.timeoutMs - (now() - startedAt);
      if (left <= 0) throw error;
      try {
        return await second(profile, body, { ...options, timeoutMs: left });
      } catch (other) {
        throw other instanceof NoRelayRoute ? error : other;
      }
    }
  };
}
