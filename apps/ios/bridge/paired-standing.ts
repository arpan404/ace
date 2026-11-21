import type { ClientApi } from "@ace/client";
import { provePaired } from "@ace/client/standing";

/**
 * Whether this phone holds the person's standing on its paired machine's socket (ADR 0190 §7):
 * `proven` once the daemon took the proof, `missing` when the phone has no key for the machine
 * (paired before it named one) or the daemon refused it (an ordinary link, or a new owner).
 */
export type PairedStanding = "proven" | "missing";

/**
 * Keeps a paired machine's socket proving the person's standing (ADR 0190 §7). On each new
 * socket (a new nonce) it has Swift sign `pairedStandingText` over that socket's challenge with
 * the Secure Enclave key it named when pairing, and sends `device.standing`. The private key
 * never enters JavaScript: `sign` is the host's `standing.sign`, which signs only that text, for
 * this machine and device. A paired standing lasts the socket, so it proves again on reconnect,
 * never on a timer. A proof for a socket that has since been replaced is neither sent nor
 * reported; a socket that drops mid-proof reports nothing, and the next one proves again.
 */
export function keepPairedStanding(
  client: Pick<ClientApi, "request"> & Pick<Partial<ClientApi>, "standingChallenge">,
  sign: (text: string) => Promise<string>,
  report: (standing: PairedStanding) => void,
): { proveNow(): Promise<boolean>; stop(): void } {
  const selection = client.standingChallenge?.();
  let stopped = false;
  let proving: string | undefined;
  const proveNow = async (): Promise<boolean> => {
    const challenge = selection?.getSnapshot();
    if (stopped || !challenge) return false;
    const current = () => !stopped && selection?.getSnapshot()?.nonce === challenge.nonce;
    let proof: string;
    try {
      proof = await provePaired({ challenge, key: { sign } });
    } catch {
      // No key for this machine on this phone: it was paired before it named one.
      if (current()) report("missing");
      return false;
    }
    if (!current()) return false;
    const reply = await client.request({ type: "device.standing", proof }).catch(() => undefined);
    if (!reply || !current()) return false;
    const ok = reply.result.ok === true && reply.result.member === undefined;
    report(ok ? "proven" : "missing");
    return ok;
  };
  const changed = () => {
    const nonce = selection?.getSnapshot()?.nonce;
    if (nonce === undefined || nonce === proving) return;
    proving = nonce;
    void proveNow();
  };
  const unsubscribe = selection?.subscribe(changed) ?? (() => {});
  changed();
  return {
    proveNow,
    stop() {
      stopped = true;
      unsubscribe();
    },
  };
}
