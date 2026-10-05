import { afterEach, expect, test } from "vitest";
import { closeDeckFixtures, deckFixture } from "./test-support.ts";
import { plan } from "./test-artifacts.ts";

afterEach(closeDeckFixtures);

// Scripted provider boundary; no installed provider CLIs are invoked. What the Deck UI says a
// rejection does is pinned here against the real daemon, not only against the fake conductor.
test("rejecting one card's merge declines that card while the deck keeps running and finishes", async () => {
  const h = await deckFixture({ cards: plan({ a: [], b: [] }), mergeAsk: true });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  const gated = await h.waitFor(
    (run) => run.needsUser.filter((gate) => gate.kind === "merge").length === 2,
  );
  const first = gated.needsUser.find((gate) => gate.workstream === "a");
  if (!first) throw new Error("Merge gate for a missing");
  expect(
    await h.commands({
      type: "conductor.approve",
      runId: h.runId,
      approval: { gateId: first.id, decision: "reject" },
    }),
  ).toMatchObject({ ok: true });
  const declined = await h.waitFor((run) => run.dag.some((node) => node.state === "declined"));
  expect(declined.phase).toBe("running");
  expect(declined.needsUser.map((gate) => [gate.kind, gate.workstream])).toEqual([["merge", "b"]]);
  const second = declined.needsUser[0];
  if (!second) throw new Error("Merge gate for b missing");
  expect(
    await h.commands({
      type: "conductor.approve",
      runId: h.runId,
      approval: { gateId: second.id, decision: "approve" },
    }),
  ).toMatchObject({ ok: true });
  const done = await h.waitFor((run) => run.phase === "done");
  expect(done.dag.map((node) => [node.id, node.state])).toEqual([
    ["a", "declined"],
    ["b", "integrated"],
  ]);
  expect(done.branch).toBeTruthy();
});

test("rejecting the plan drafts another one instead of cancelling the deck", async () => {
  const h = await deckFixture({ planApproval: "required" });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  const gated = await h.waitFor((run) => run.needsUser[0]?.kind === "plan");
  const gate = gated.needsUser[0];
  if (!gate) throw new Error("Plan gate missing");
  expect(
    await h.commands({
      type: "conductor.approve",
      runId: h.runId,
      approval: { gateId: gate.id, decision: "reject" },
    }),
  ).toMatchObject({ ok: true });
  const redrafted = await h.waitFor(
    (run) => run.needsUser[0]?.kind === "plan" && run.needsUser[0].id !== gate.id,
  );
  expect(redrafted.phase).toBe("planning");
  expect(h.sends.filter((entry) => entry.text.includes("rejected an earlier plan"))).toHaveLength(
    1,
  );
});
