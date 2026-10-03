import { afterEach, expect, test } from "vitest";
import { deckFixture, closeDeckFixtures } from "./test-support.ts";
import { ManualClock } from "../engine/test-support.ts";
import { plan } from "./test-artifacts.ts";
afterEach(closeDeckFixtures);
// Scripted provider boundary; no installed provider CLIs are invoked.
test("a complete plan beyond transcript preview size reaches workers with its final card", async () => {
  const cards = plan();
  const card = cards.workstreams[0];
  if (!card) throw new Error("Card missing");
  card.brief.instructions = "long instructions ".repeat(850);
  // Explicit invariant checked below instead of relying on a plausible short plan.
  expect(JSON.stringify(cards).length).toBeGreaterThan(4096);
  const h = await deckFixture({ cards });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((run) => run.phase === "done");
  expect((await h.read()).plan?.workstreams[0]?.brief.instructions).toBe(
    cards.workstreams[0]?.brief.instructions,
  );
});

test("a plan at the compact JSON size limit is accepted with its artifact envelope", async () => {
  const cards = plan();
  const card = cards.workstreams[0];
  if (!card) throw new Error("Card missing");
  card.brief.risks = Array.from({ length: 32 }, () => "r".repeat(16384));
  card.brief.acceptance = Array.from({ length: 31 }, (_, index) => {
    const prefix = `Criterion ${index}: `;
    return prefix + "a".repeat(16384 - prefix.length);
  });
  card.brief.instructions += "i".repeat(1_048_576 - Buffer.byteLength(JSON.stringify(cards)));
  expect(Buffer.byteLength(JSON.stringify(cards))).toBe(1_048_576);
  const h = await deckFixture({ cards, planApproval: "required" });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((run) => run.needsUser[0]?.kind === "plan");
  expect((await h.read()).plan).toEqual(cards);
});

test("a complete review beyond transcript preview size is admitted and integrates its card", async () => {
  const h = await deckFixture({ longReview: true });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((run) => run.phase === "done");
  expect((await h.read()).dag[0]?.state).toBe("integrated");
});

test("missing worker worktree still observes completion and escalates the absent artifact", async () => {
  const clock = new ManualClock();
  const h = await deckFixture({ removeWorkerTree: true, stallAfterMs: 100, clock });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((run) =>
    run.lanes.some((lane) => lane.role === "worker" && lane.status === "done"),
  );
  await h.advance();
  await h.waitFor((run) => run.needsUser.some((gate) => gate.kind === "escalation"));
  expect((await h.read()).dag[0]?.state).not.toBe("integrated");
});

test("Deck resume retries a rejected queue revision after a concurrent human queue edit", async () => {
  const h = await deckFixture({ hold: true });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((run) =>
    run.lanes.some((lane) => lane.role === "worker" && lane.status === "working"),
  );
  await h.settle();
  const worker = h.sends.find((send) => send.text.includes("Implement this workstream"));
  if (!worker || !h.daemon.engine) throw new Error("Worker missing");
  expect(await h.commands({ type: "conductor.pause", runId: h.runId })).toMatchObject({ ok: true });
  await h.settle();
  expect(h.daemon.engine?.queuePage({ threadId: worker.thread }).paused).toBe(true);
  await h.daemon.engine.flush();
  const barrier = h.holdPreparation();
  h.release();
  expect(await h.commands({ type: "conductor.resume", runId: h.runId })).toMatchObject({
    ok: true,
  });
  await barrier.reached;
  const queue = h.daemon.engine.queuePage({ threadId: worker.thread });
  expect(
    await h.commands({
      type: "queue.pause",
      threadId: worker.thread,
      expectedRevision: queue.revision,
    }),
  ).toMatchObject({ ok: true });
  barrier.release();
  await h.waitFor((run) => !!run.executionError);
  await h.advance();
  await h.waitFor((run) => run.phase === "done");
  expect(
    h.sends.filter(
      (send) =>
        send.thread === worker.thread &&
        send.text.includes("Continue the interrupted task from native history"),
    ),
  ).toHaveLength(1);
  expect(
    h.sends.filter(
      (send) => send.thread === worker.thread && send.text.includes("Implement this workstream"),
    ),
  ).toHaveLength(1);
});

test("root preparation retries capacity rejection once the occupying engine thread releases its slot", async () => {
  const clock = new ManualClock();
  const h = await deckFixture({
    engineCapacity: 1,
    hostCapacity: 4,
    planApproval: "required",
    clock,
  });
  const occupied = await h.commands({
    type: "thread.create",
    provider: "codex",
    workspaceId: h.spec.workspaceId,
    input: [{ type: "text", text: "Hold external thread" }],
  });
  if (!occupied.ok || !occupied.threadId) throw new Error("Occupying thread missing");
  await h.daemon.engine?.flush();
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((run) => !!run.executionError);
  expect(
    await h.commands({ type: "thread.interrupt", threadId: occupied.threadId, cascade: true }),
  ).toMatchObject({ ok: true });
  await h.daemon.engine?.flush();
  // The injected idle timer closes the provider before root admission retries.
  await h.advance();
  await h.advance();
  await h.waitFor((run) => run.needsUser[0]?.kind === "plan");
  expect(h.sends.filter((send) => send.text.includes("Plan this project"))).toHaveLength(1);
});

test("successful CI at a different PR head cannot verify the reviewed revision", async () => {
  const h = await deckFixture({ prOnly: true });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((run) => run.dag[0]?.state === "verifying");
  h.forge.passAt("0".repeat(40));
  await h.advance();
  await h.waitFor((run) => run.needsUser.length > 0);
  expect((await h.read()).phase).not.toBe("done");
  expect((await h.read()).dag[0]?.state).not.toBe("integrated");
});
