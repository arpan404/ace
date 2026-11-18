import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { hostSocket } from "./host-socket-test-support.ts";
import { marketWorld } from "./market-world-test-support.ts";

/*
 * `ace market` against a real daemon, a fake market and a fake ace account (ADR 0178 §12):
 * a publisher's draft reaches the market with this machine's grant, and an agent's shell
 * (ACE_THREAD_ID) asking to withdraw gets the person's request instead, whatever --yes says.
 */

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) await step();
});
const world = (options: { signedInAt?: () => number } = {}) => marketWorld(cleanup, options);

test("market publish --draft uploads the folder with this machine's grant and prints the draft", async () => {
  const { market, skill, cli } = await world();
  const published = await cli([
    "market",
    "publish",
    "spade-skill",
    skill,
    "--version",
    "1.0.0",
    "--draft",
    "--json",
  ]);
  expect(published.code, published.stderr).toBe(0);
  expect(JSON.parse(published.stdout)).toMatchObject({
    kind: "draft",
    draft: { id: "drf_abcdefgh", type: "spade-skill", name: "triage-mail", version: "1.0.0" },
  });
  const upload = market.seen.find(
    (seen) => seen.method === "POST" && seen.path.startsWith("/v1/me/drafts?"),
  );
  expect(upload?.authorization).toMatch(/^Bearer .+/);
  // --draft stops at the draft: nothing was published.
  expect(market.seen.some((seen) => seen.path.endsWith("/publish"))).toBe(false);
});

test("market withdraw from an agent's shell exits 2 with the person's request, even with --yes", async () => {
  const { f, market, cli } = await world();
  const thread = f.caller.threadId;
  for (const yes of [[], ["--yes"]]) {
    const asked = await cli(
      [
        "market",
        "withdraw",
        "spade-skill/triage-mail@1.0.0",
        "--reason",
        "Broken",
        "--json",
        ...yes,
      ],
      { ACE_THREAD_ID: thread },
    );
    expect(asked.code, asked.stderr).toBe(2);
    const error = z
      .object({ code: z.literal("person_only"), request: z.string().min(1) })
      .loose()
      .parse(JSON.parse(asked.stdout));
    const interaction = f.daemon.store.getInteraction(error.request);
    expect(interaction).toMatchObject({ threadId: thread, state: "pending" });
  }
  expect(market.seen.some((seen) => seen.path.endsWith("/withdraw"))).toBe(false);
});

test("the same withdrawal from the person's own terminal goes to the market", async () => {
  const { market, cli } = await world();
  const withdrawn = await cli([
    "market",
    "withdraw",
    "spade-skill/triage-mail@1.0.0",
    "--reason",
    "Broken",
    "--json",
  ]);
  expect(withdrawn.code, withdrawn.stderr).toBe(0);
  expect(JSON.parse(withdrawn.stdout)).toEqual({ kind: "pending", what: "withdrawal" });
  expect(market.seen.some((seen) => seen.path.endsWith("/withdraw"))).toBe(true);
});

const elevenMinutesAgo = () => Date.now() - 11 * 60_000;
const install = {
  op: "install",
  id: "rv-unknown",
  hash: "a".repeat(64),
  choices: { bots: [], needs: {}, startRoutines: false },
};

test("a thread-less install over the host token needs a sign-in from the last ten minutes", async () => {
  const stale = await world({ signedInAt: elevenMinutesAgo });
  const socket = await hostSocket(stale.home, "ace-cli", cleanup);
  expect(await socket.market("stale", install)).toMatchObject({ op: "error", code: "reauth" });
  const fresh = await world();
  const again = await hostSocket(fresh.home, "ace-cli", cleanup);
  // Past the sign-in check, the marketplace itself answers: there's no such review.
  expect(await again.market("fresh", install)).not.toMatchObject({ code: "reauth" });
});

test("a person-only market request is answered over the host token only after a fresh sign-in", async () => {
  for (const [signedInAt, answered] of [
    [elevenMinutesAgo, false],
    [undefined, true],
  ] as const) {
    const { f, cli, home, market } = await world(signedInAt ? { signedInAt } : {});
    const asked = await cli(
      ["market", "withdraw", "spade-skill/triage-mail@1.0.0", "--reason", "Broken", "--json"],
      { ACE_THREAD_ID: f.caller.threadId },
    );
    const request = z
      .object({ request: z.string() })
      .loose()
      .parse(JSON.parse(asked.stdout)).request;
    // An agent's device never answers it, signed in or not.
    const agent = await hostSocket(home, "ace-agent", cleanup);
    expect(await agent.answer("by-agent", request)).toMatchObject({
      ok: false,
      error: "human_answer_required",
    });
    const person = await hostSocket(home, "ace-cli", cleanup);
    const reply = await person.answer("by-host", request);
    if (answered) {
      expect(reply).toMatchObject({ type: "commandResult", ok: true });
      await expect
        .poll(() => market.seen.some((seen) => seen.path.endsWith("/withdraw")))
        .toBe(true);
    } else {
      expect(reply).toMatchObject({ type: "error", code: "reauth" });
      expect(f.daemon.store.getInteraction(request)?.state).toBe("pending");
      expect(market.seen.some((seen) => seen.path.endsWith("/withdraw"))).toBe(false);
    }
  }
});

test("the person's own terminal needs a fresh sign-in to withdraw, too", async () => {
  const { market, cli } = await world({ signedInAt: elevenMinutesAgo });
  const refused = await cli([
    "market",
    "withdraw",
    "spade-skill/triage-mail@1.0.0",
    "--reason",
    "Broken",
    "--json",
  ]);
  expect(refused.code).toBe(2);
  expect(JSON.parse(refused.stdout)).toMatchObject({ code: "reauth" });
  expect(market.seen.some((seen) => seen.path.endsWith("/withdraw"))).toBe(false);
});
