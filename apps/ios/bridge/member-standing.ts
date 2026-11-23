import type { Selection, StandingChallenge } from "@ace/client";
import { z } from "zod";

/*
 * A member's standing on an organization's host (ADR 0206 §2.2), from the iPhone. The host admits
 * the phone with a member grant; reading what only some roles may (its audit log) also needs the
 * standing proven on the socket: the grant and the phone's key's signature over the socket's
 * challenge. Native signs (`member.standing`): it holds the grant and the key, and builds the text
 * from this socket's challenge. This keeps each socket proven: on its first welcome, every few
 * minutes while it lasts, and never for a socket since replaced. A personal machine has no member
 * route, so native signs nothing for it and nothing is sent.
 */

/** Well inside the five minutes a member grant lives. */
export const MEMBER_REPROVE_MS = 4 * 60_000;

/** What native signs for one challenge, or undefined where the phone isn't a member. */
export type MemberProver = (
  challenge: StandingChallenge,
) => Promise<{ grant: string; proof: string } | undefined>;

const Signed = z.object({
  grant: z.string().min(1).max(2048),
  proof: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});

/** Native's signer: `member.standing` with the socket's challenge; a refusal is no proof. */
export function nativeMemberProver(
  call: (
    operation: "member.standing",
    input: { host: string; nonce: string; binding?: string },
  ) => Promise<string>,
): MemberProver {
  return async (challenge) => {
    try {
      const answer = await call("member.standing", {
        host: challenge.host,
        nonce: challenge.nonce,
        ...(challenge.binding === undefined ? {} : { binding: challenge.binding }),
      });
      const signed = Signed.safeParse(JSON.parse(answer));
      return signed.success ? signed.data : undefined;
    } catch {
      return undefined;
    }
  };
}

/** What the keeper needs of the SDK's client: its state, socket challenge and requests. */
export interface StandingClient {
  readonly state: string;
  standingChallenge?(): Selection<StandingChallenge | undefined>;
  request(message: { type: "account.standing"; grant: string; proof: string }): Promise<{
    result: { ok: true; member?: unknown } | { ok: false };
  }>;
}

const nothing = () => {};

export function keepMemberStanding(
  client: StandingClient,
  prove: MemberProver,
  timers: { set(delayMs: number, callback: () => void): () => void },
): { proveNow(): Promise<boolean>; stop(): void } {
  const selection = client.standingChallenge?.();
  let stopped = false;
  let cancel: () => void = nothing;
  let proving: string | undefined;
  const proveNow = async (): Promise<boolean> => {
    const challenge = selection?.getSnapshot();
    if (stopped || !challenge) return false;
    const current = () => !stopped && selection?.getSnapshot()?.nonce === challenge.nonce;
    const signed = await prove(challenge).catch(() => undefined);
    if (!signed || !current()) return false;
    const reply = await client
      .request({ type: "account.standing", ...signed })
      .catch(() => undefined);
    return reply?.result.ok === true && reply.result.member !== undefined && current();
  };
  const schedule = () => {
    cancel();
    cancel = timers.set(MEMBER_REPROVE_MS, () => {
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
