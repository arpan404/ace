import { expect, test } from "vitest";
import type { StandingChallenge } from "@ace/client";
import { keepMemberStanding, MEMBER_REPROVE_MS, type MemberProver } from "./member-standing.ts";

/*
 * A member's standing on an organization's host (ADR 0206 §2.2), kept from the iPhone's bridge:
 * each new socket proves with what the phone's native side signs for that socket's challenge,
 * again every few minutes while it lasts, and never for a socket that has since been replaced.
 * The daemon is the boundary here: the host's answer is what the test gives.
 */

function harness(
  answer: { ok: boolean; member?: { org: string; role: string } } = {
    ok: true,
    member: { org: "org_acme", role: "admin" },
  },
) {
  let challenge: StandingChallenge | undefined;
  const listeners = new Set<() => void>();
  const sent: unknown[] = [];
  const timers: { at: number; run(): void }[] = [];
  let clock = 0;
  const client = {
    state: "ready" as const,
    standingChallenge: () => ({
      getSnapshot: () => challenge,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
    request: async (message: unknown) => {
      sent.push(message);
      return {
        type: "account.standing.result" as const,
        requestId: "r",
        result: answer.ok
          ? { ok: true as const, until: 1, ...(answer.member ? { member: answer.member } : {}) }
          : { ok: false as const, code: "forbidden", message: "no" },
      };
    },
  };
  const socket = (nonce: string) => {
    challenge = { host: "H".repeat(52), nonce, binding: "bind", device: "phone" };
    for (const listener of listeners) listener();
  };
  const later = async (ms: number) => {
    clock += ms;
    for (const timer of timers.splice(0).filter((each) => each.at <= clock)) timer.run();
    await settle();
  };
  const scheduler = {
    set(delayMs: number, run: () => void) {
      const timer = { at: clock + delayMs, run };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
  };
  return { client, sent, socket, later, scheduler };
}

const idle = () => {};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const signer: MemberProver = async (challenge) => ({
  grant: `grant-for-${challenge.nonce}`,
  proof: "p".repeat(86),
});

test("a new socket proves with what the native side signed for its own challenge", async () => {
  const { client, sent, socket, scheduler } = harness();
  const asked: StandingChallenge[] = [];
  keepMemberStanding(
    client,
    async (challenge) => (asked.push(challenge), signer(challenge)),
    scheduler,
  );

  socket("n1");
  await settle();

  expect(asked).toEqual([{ host: "H".repeat(52), nonce: "n1", binding: "bind", device: "phone" }]);
  expect(sent).toEqual([
    { type: "account.standing", grant: "grant-for-n1", proof: "p".repeat(86) },
  ]);
});

test("the standing is proven again before its grant runs out, and on the next socket", async () => {
  const { client, sent, socket, later, scheduler } = harness();
  keepMemberStanding(client, signer, scheduler);
  socket("n1");
  await settle();

  await later(MEMBER_REPROVE_MS);
  socket("n2");
  await settle();

  expect(sent.map((each) => (each as { grant: string }).grant)).toEqual([
    "grant-for-n1",
    "grant-for-n1",
    "grant-for-n2",
  ]);
});

test("a proof signed while its socket was replaced isn't sent on the new one", async () => {
  const { client, sent, socket, scheduler } = harness();
  let release: () => void = idle;
  const slow: MemberProver = (challenge) =>
    new Promise((resolve) => {
      release = () => resolve({ grant: `grant-for-${challenge.nonce}`, proof: "p".repeat(86) });
    });
  keepMemberStanding(client, slow, scheduler);
  socket("n1");
  await settle();
  const first = release;
  socket("n2");
  await settle();

  first();
  await settle();

  expect(sent).toEqual([]);
});

test("a machine the phone isn't a member of proves nothing", async () => {
  const { client, sent, socket, scheduler } = harness();
  const keeper = keepMemberStanding(client, async () => undefined, scheduler);
  socket("n1");
  await settle();

  expect(sent).toEqual([]);
  expect(await keeper.proveNow()).toBe(false);
});

test("only a member's standing counts as proven", async () => {
  const person = harness({ ok: true });
  const personal = keepMemberStanding(person.client, signer, person.scheduler);
  person.socket("n1");
  expect(await personal.proveNow()).toBe(false);

  const host = harness();
  const member = keepMemberStanding(host.client, signer, host.scheduler);
  host.socket("n1");
  expect(await member.proveNow()).toBe(true);
});
