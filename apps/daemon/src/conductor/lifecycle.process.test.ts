import { afterEach, expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { closeDeckFixtures, deckFixture } from "./test-support.ts";

afterEach(closeDeckFixtures);

async function badReview() {
  const h = await deckFixture({ wrongReviewRevision: true, stallAfterMs: 100 });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((run) =>
    run.lanes.some((lane) => lane.role === "reviewer" && lane.status === "done"),
  );
  await h.advance();
  const run = await h.waitFor((view) => view.needsUser.some((gate) => gate.kind === "escalation"));
  const gate = run.needsUser.find((entry) => entry.kind === "escalation");
  if (!gate) throw new Error("Missing escalation");
  return { h, gate };
}

test.each(["reject", "cancel"] as const)(
  "a done reviewer with an invalid artifact settles on %s",
  async (action) => {
    const { h, gate } = await badReview();
    expect(
      await h.commands(
        action === "cancel"
          ? { type: "conductor.cancel", runId: h.runId }
          : {
              type: "conductor.approve",
              runId: h.runId,
              approval: { gateId: gate.id, decision: "reject" },
            },
      ),
    ).toMatchObject({ ok: true });
    await h.settle();
    const run = await h.read();
    expect(run.phase).toBe(action === "cancel" ? "cancelled" : "done");
    expect(run.lanes).toEqual([]);
    expect(run.needsUser).toEqual([]);
  },
);

test("retrying a done reviewer launches a new reviewer", async () => {
  const { h, gate } = await badReview();
  const first = (await h.read()).delegations.filter(
    (edge) => h.daemon.store.getThread(ThreadId.parse(edge.threadId))?.deck?.role === "reviewer",
  );
  expect(
    await h.commands({
      type: "conductor.approve",
      runId: h.runId,
      approval: { gateId: gate.id, decision: "approve" },
    }),
  ).toMatchObject({ ok: true });
  await h.settle();
  const next = (await h.read()).delegations.filter(
    (edge) => h.daemon.store.getThread(ThreadId.parse(edge.threadId))?.deck?.role === "reviewer",
  );
  expect(next.length).toBe(first.length + 1);
});

test("cancelling a provider question cancels its interaction and settles the run", async () => {
  const h = await deckFixture({ question: true });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  const run = await h.waitFor((view) => view.needsUser.some((gate) => gate.kind === "provider"));
  const gate = run.needsUser.find((entry) => entry.kind === "provider");
  if (!gate?.interactionId) throw new Error("Missing question");
  expect(await h.commands({ type: "conductor.cancel", runId: h.runId })).toMatchObject({
    ok: true,
  });
  await h.settle();
  expect(h.daemon.store.getInteraction(gate.interactionId)?.state).toBe("cancelled");
  expect((await h.read()).phase).toBe("cancelled");
});

test("an ignored interrupt is followed by session termination before cancelled is published", async () => {
  const h = await deckFixture({ hold: true, ignoreInterrupt: true, stallAfterMs: 100 });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((view) =>
    view.lanes.some((lane) => lane.role === "worker" && lane.status === "working"),
  );
  expect(await h.commands({ type: "conductor.cancel", runId: h.runId })).toMatchObject({
    ok: true,
  });
  await h.settle();
  expect((await h.read()).phase).toBe("cancelling");
  await h.advance(30_000);
  expect((await h.read()).phase).toBe("cancelled");
});

test("a worker recovering after a stall closes its escalation and completes", async () => {
  const h = await deckFixture({ hold: true, stallAfterMs: 100 });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((view) =>
    view.lanes.some((lane) => lane.role === "worker" && lane.status === "working"),
  );
  await h.advance();
  await h.waitFor((view) => view.needsUser.some((gate) => gate.kind === "escalation"));
  const worker = h.sends.find((send) => send.text.includes("Implement this workstream"));
  if (!worker) throw new Error("Missing worker");
  await h.finish(worker.thread);
  await h.settle();
  expect((await h.read()).needsUser).toEqual([]);
  await h.waitFor((view) => view.phase === "done");
});

test("resuming after a long pause gives the native worker a fresh stall interval", async () => {
  const h = await deckFixture({ hold: true, stallAfterMs: 100 });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((view) =>
    view.lanes.some((lane) => lane.role === "worker" && lane.status === "working"),
  );
  expect(await h.commands({ type: "conductor.pause", runId: h.runId })).toMatchObject({ ok: true });
  await h.advance(200_000);
  expect((await h.read()).needsUser).toEqual([]);
  expect(await h.commands({ type: "conductor.resume", runId: h.runId })).toMatchObject({
    ok: true,
  });
  await h.settle();
  expect((await h.read()).needsUser).toEqual([]);
  expect((await h.read()).phase).toBe("running");
});
