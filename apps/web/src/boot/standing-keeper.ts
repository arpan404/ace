import type { ClientApi, StandingChallenge } from "@ace/client";

/**
 * Proves the person's standing on a socket (ADR 0190): the person's grant for that daemon and
 * the device key's signature over the challenge, or undefined when this window holds no session
 * of the person's.
 */
export type StandingProver = (
  challenge: StandingChallenge,
) => Promise<{ grant: string; proof: string } | undefined>;

const noop = () => {};

/** How often a socket proves again: well inside the five minutes a person's grant lives. */
export const STANDING_REPROVE_MS = 4 * 60_000;

/**
 * Keeps `client`'s socket proving the person's standing (ADR 0190): on each new socket (a new
 * nonce), every few minutes while it lasts, and when asked (`proveNow`, after a sign-in). It runs
 * in the tab, which holds the key and the session; a worker-hosted client mirrors its socket's
 * challenge here. A proof for a socket that has since been replaced is not sent.
 */
export function keepStanding(
  client: Pick<ClientApi, "request" | "state"> & Pick<Partial<ClientApi>, "standingChallenge">,
  prove: StandingProver,
  timers: { set(delayMs: number, callback: () => void): () => void },
): { proveNow(): Promise<void>; stop(): void } {
  const selection = client.standingChallenge?.();
  let stopped = false;
  let cancel: () => void = noop;
  let proving: string | undefined;
  const proveNow = async (): Promise<void> => {
    const challenge = selection?.getSnapshot();
    if (stopped || !challenge) return;
    const proven = await prove(challenge).catch(() => undefined);
    if (stopped || !proven || selection?.getSnapshot()?.nonce !== challenge.nonce) return;
    await client
      .request({ type: "account.standing", grant: proven.grant, proof: proven.proof })
      .catch(() => {});
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
