import type { CommandRequest, CommandRunner } from "./command.ts";
import { ForgeError } from "./errors.ts";

/** How long a verified identity admits reads without another identity probe. */
export const identityVerificationMs = 60_000;

export type IdentityRunnerOptions = {
  now: () => number;
  /** When the caller last verified the account itself, so the first read needs no probe. */
  verifiedAt?: number;
  ttlMs?: number;
  /** Each successful probe, so the caller's own verification window moves with it. */
  onVerified?: (at: number) => void;
  /** A probe named another account: the caller's window must not admit it again. */
  onMismatch?: () => void;
};

export type PinnedRunnerInput = {
  runner: CommandRunner;
  account: string;
  /** The CLI's current API account. */
  identify: (signal: AbortSignal) => Promise<string>;
  /** Requests this runner pins; any other passes straight through. */
  pins: (request: CommandRequest) => boolean;
  isWrite: (request: CommandRequest) => boolean;
  assertCurrent: () => void | Promise<void>;
  options?: IdentityRunnerOptions | undefined;
};

/**
 * Pin every pinned request to its admitted account; never switch shared CLI configuration.
 * Reads reuse a verification for a short window, and outside it run beside one shared probe
 * whose answer gates the result. Writes are verified immediately before dispatch. A probe that
 * names another account fails closed. Without `options` (no clock), every read is verified.
 */
export function pinnedRunner(input: PinnedRunnerInput): CommandRunner {
  const { runner, account, identify, options, assertCurrent } = input;
  let verifiedAt = options?.verifiedAt;
  const ttl = options?.ttlMs ?? identityVerificationMs;
  const fresh = () => {
    if (!options || verifiedAt === undefined) return false;
    const age = options.now() - verifiedAt;
    return age >= 0 && age < ttl;
  };
  const verified = () => {
    if (!options) return;
    verifiedAt = options.now();
    options.onVerified?.(verifiedAt);
  };
  const verify = async (signal: AbortSignal) => {
    if ((await identify(signal)) !== account) {
      verifiedAt = undefined;
      options?.onMismatch?.();
      throw new ForgeError("forbidden");
    }
    verified();
  };
  // Reads that need a probe at the same moment share one.
  let probing: Promise<void> | undefined;
  const verifyRead = async (signal: AbortSignal) => {
    const shared = (probing ??= verify(signal).finally(() => (probing = undefined)));
    try {
      await shared;
    } catch (error) {
      // Another read's cancellation proves nothing about this one: probe for it alone.
      if (error instanceof ForgeError && error.kind === "cancelled" && !signal.aborted)
        return verify(signal);
      throw error;
    }
  };
  return async (request: CommandRequest) => {
    await assertCurrent();
    if (!input.pins(request)) return runner(request);
    const write = input.isWrite(request);
    if (!write && !fresh()) {
      // A read has no effect, so it runs beside its identity probe instead of after it; its
      // answer is only returned once the probe proves the account it was read as.
      const [checked, read] = await Promise.allSettled([
        verifyRead(request.signal),
        runner(request),
      ]);
      if (checked.status === "rejected") throw checked.reason;
      // Preferences may change while the identity process is running.
      await assertCurrent();
      if (read.status === "rejected") throw read.reason;
      return read.value;
    }
    if (write) {
      await verify(request.signal);
      await assertCurrent();
    }
    const result = await runner(request);
    if (!write) return result;
    // A dispatched write keeps its response. Only a confirmed different account, or changed
    // preferences, make its outcome uncertain; an unavailable probe proves nothing.
    try {
      if ((await identify(request.signal)) !== account) return { ...result, identityChanged: true };
      verified();
    } catch {
      /* Offline, rate limited or cancelled after the write: no evidence of a switch. */
    }
    try {
      await assertCurrent();
    } catch {
      return { ...result, identityChanged: true };
    }
    return result;
  };
}
