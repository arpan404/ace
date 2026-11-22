import { expect, test } from "vitest";
import type { StandingChallenge } from "@ace/client";
import type { AppStandingKey } from "./app-standing-key.ts";
import { keepStanding, type StandingProver } from "./standing-keeper.ts";
import { appProver, enrollAppKey } from "./window-prover.ts";

/*
 * A desktop window and its main process (ADR 0190, amendment 1): the window only asks. The first
 * socket proves the owner's grant and asks main to enroll; every socket main tagged after that
 * is proven by main, with no grant.
 */

const origin = "https://acehq.dev";

/** Main, as the window sees it: proves once a key is enrolled, enrolls once asked. */
function mainProcess() {
  let enrolled = false;
  const asked: string[] = [];
  const app: AppStandingKey = {
    prove: async () => {
      asked.push("prove");
      return enrolled;
    },
    enroll: async () => {
      asked.push("enroll");
      enrolled = true;
      return true;
    },
  };
  return { app, asked };
}

/** A daemon socket whose challenge the test sets; it takes any grant proof. */
function socket() {
  let challenge: StandingChallenge | undefined;
  const listeners = new Set<() => void>();
  const sent: string[] = [];
  return {
    sent,
    open(nonce: string, appSocket = true) {
      challenge = {
        host: "H".repeat(52),
        nonce,
        binding: undefined,
        device: "window",
        ...(appSocket ? { appSocket: true } : {}),
      };
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
      request: async (message: { type: string }) => {
        sent.push(`${message.type} ${challenge?.nonce}`);
        return { type: "account.standing.result", requestId: "s", result: { ok: true, until: 1 } };
      },
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const timers = { set: () => () => {} };
const grant: StandingProver = async (challenge) => ({
  type: "account.standing",
  grant: `g-${challenge.nonce}`,
  proof: "p",
});

test("a desktop window proves the owner's grant once, asks main to enroll, then main proves every tagged socket", async () => {
  const main = mainProcess();
  const s = socket();
  const keeper = keepStanding(
    s.api as never,
    appProver(main.app, origin),
    timers,
    grant,
    enrollAppKey(main.app, origin),
  );
  s.open("n1");
  await settle();
  s.open("n2");
  await settle();
  s.open("n3");
  await settle();
  // Only the first socket sent a grant; main proved the rest without the window sending any.
  expect(s.sent).toEqual(["account.standing n1"]);
  expect(main.asked).toEqual(["prove", "enroll", "prove", "prove"]);
  keeper.stop();
});

test("a socket main didn't tag never counts main's proof as its own", async () => {
  const main = mainProcess();
  await main.app.enroll(origin);
  const s = socket();
  const keeper = keepStanding(s.api as never, appProver(main.app, origin), timers, grant);
  s.open("n1", false);
  await settle();
  expect(s.sent).toEqual(["account.standing n1"]);
  expect(main.asked).toEqual(["enroll"]);
  keeper.stop();
});
