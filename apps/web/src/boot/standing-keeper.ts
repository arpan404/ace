import type { ClientApi, StandingChallenge } from "@ace/client";

/**
 * Proves the person's standing on a socket (ADR 0190), or undefined when it can't: the person's
 * grant for that daemon and the window key's signature over the challenge, or, for a device
 * paired from a person's link, its kept key's signature.
 */
export type StandingProver = (challenge: StandingChallenge) => Promise<
  | { type: "account.standing"; grant: string; proof: string }
  | { type: "device.standing"; proof: string }
  /** The desktop app's main process proved this window's sockets itself (ADR 0190, amd. 1). */
  | { type: "proven" }
  | undefined
>;

const noop = () => {};

/** How often a socket proves again: well inside the five minutes a person's grant lives. */
export const STANDING_REPROVE_MS = 4 * 60_000;

/**
 * Keeps `client`'s socket proving the person's standing (ADR 0190): on each new socket (a new
 * nonce), every few minutes while it lasts, and when asked (`proveNow`, after a sign-in). It runs
 * in the tab, which holds the key and the session; a worker-hosted client mirrors its socket's
 * challenge here. A proof for a socket that has since been replaced is not sent. When `prove`
 * can't and `fallback` can, `afterFallback` runs on that socket (the desktop app keeps its key
 * then, so the next socket proves without the fallback).
 */
export function keepStanding(
  client: Pick<ClientApi, "request" | "state"> & Pick<Partial<ClientApi>, "standingChallenge">,
  prove: StandingProver,
  timers: { set(delayMs: number, callback: () => void): () => void },
  fallback?: StandingProver,
  afterFallback?: (challenge: StandingChallenge) => Promise<unknown>,
): { proveNow(): Promise<boolean>; stop(): void } {
  const selection = client.standingChallenge?.();
  let stopped = false;
  let cancel: () => void = noop;
  let proving: string | undefined;
  const proveNow = async (): Promise<boolean> => {
    const challenge = selection?.getSnapshot();
    if (stopped || !challenge) return false;
    const current = () => !stopped && selection?.getSnapshot()?.nonce === challenge.nonce;
    const send = async (prover: StandingProver) => {
      const proven = await prover(challenge).catch(() => undefined);
      if (!current() || !proven) return false;
      if (proven.type === "proven") return true;
      const reply = await client.request(proven).catch(() => undefined);
      return reply?.result.ok === true && reply.result.member === undefined && current();
    };
    if (await send(prove)) return true;
    if (fallback === undefined || !current() || !(await send(fallback))) return false;
    await afterFallback?.(challenge).catch(() => undefined);
    return true;
  };
  const schedule = () => {
    cancel();
    cancel = timers.set(STANDING_REPROVE_MS, () => {
      // A client that gave up for good proves nothing more.
      if (client.state === "fatal") return stop();
      void proveNow().finally(schedule);
    });
  };
  const changed = () => {
    const nonce = selection?.getSnapshot()?.nonce;
    if (nonce === undefined || nonce === proving) return;
    proving = nonce;
    void proveNow();
    schedule();
  };
  const unsubscribe = selection?.subscribe(changed) ?? (() => {});
  function stop() {
    stopped = true;
    cancel();
    unsubscribe();
  }
  changed();
  return { proveNow, stop };
}
