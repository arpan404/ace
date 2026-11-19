import { expect, test } from "vitest";
import type { StandingChallenge } from "@ace/client";
import { keepStanding, STANDING_REPROVE_MS } from "./standing-keeper.ts";

/** A client whose socket's challenge the test sets, recording the proofs it is sent. */
function client() {
  let challenge: StandingChallenge | undefined;
  const listeners = new Set<() => void>();
  const sent: { grant: string; proof: string }[] = [];
  return {
    sent,
    socket(next: StandingChallenge | undefined) {
      challenge = next;
      for (const listener of listeners) listener();
    },
    api: {
      state: "ready" as const,
      standingChallenge: () => ({
        getSnapshot: () => challenge,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
      }),
      request: async (message: { grant: string; proof: string }) => {
        sent.push({ grant: message.grant, proof: message.proof });
        return { type: "account.standing.result", requestId: "r", result: { ok: true, until: 1 } };
      },
    },
  };
}

function timers() {
  const due: (() => void)[] = [];
  return {
    due,
    set(delayMs: number, callback: () => void) {
      expect(delayMs).toBe(STANDING_REPROVE_MS);
      due.push(callback);
      return () => void due.splice(due.indexOf(callback), 1);
    },
  };
}

const challenge = (nonce: string): StandingChallenge => ({
  host: "H".repeat(52),
  nonce,
  binding: "channel",
  device: "phone",
});
const noop = () => {};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("each new socket proves the person's standing for its own nonce, and again before the grant runs out", async () => {
  const c = client();
  const t = timers();
  const keeper = keepStanding(
    c.api as never,
    async (asked) => ({ grant: `grant-${asked.nonce}`, proof: `proof-${asked.nonce}` }),
    t,
  );
  c.socket(challenge("n1"));
  await settle();
  expect(c.sent).toEqual([{ grant: "grant-n1", proof: "proof-n1" }]);
  c.socket(challenge("n2"));
  await settle();
  expect(c.sent.at(-1)).toEqual({ grant: "grant-n2", proof: "proof-n2" });
  t.due.at(-1)?.();
  await settle();
  expect(c.sent.at(-1)).toEqual({ grant: "grant-n2", proof: "proof-n2" });
  expect(c.sent).toHaveLength(3);
  keeper.stop();
});

test("a proof made for a socket that was replaced meanwhile is not sent", async () => {
  const c = client();
  let release: () => void = noop;
  const keeper = keepStanding(
    c.api as never,
    async (asked) => {
      if (asked.nonce === "old") await new Promise<void>((resolve) => (release = resolve));
      return { grant: `grant-${asked.nonce}`, proof: `proof-${asked.nonce}` };
    },
    timers(),
  );
  c.socket(challenge("old"));
  c.socket(challenge("new"));
  await settle();
  release();
  await settle();
  expect(c.sent).toEqual([{ grant: "grant-new", proof: "proof-new" }]);
  keeper.stop();
});

test("a window holding no session of the person's sends nothing", async () => {
  const c = client();
  const keeper = keepStanding(c.api as never, async () => undefined, timers());
  c.socket(challenge("n1"));
  await settle();
  expect(c.sent).toEqual([]);
  keeper.stop();
});
