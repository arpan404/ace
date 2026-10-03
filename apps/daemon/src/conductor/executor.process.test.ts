import { expect, test } from "vitest";
import { AgentId, InteractionId, ThreadId, type McpAttribution } from "@ace/protocol";
import { deckFixture, git } from "./test-support.ts";
import { plan } from "./test-artifacts.ts";

// Not executed (tests run at merge). Scripted adapters never call provider CLIs.
test("a Deck reaches done through attached real threads and integrates each card in its private branch", async () => {
  const h = await deckFixture({ cards: plan({ a: [], b: ["a"] }) });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await expect.poll(() => h.changes.at(-1)?.phase).toBe("done");
  const run = await h.read();
  expect(run.dag.map((node) => node.state)).toEqual(["integrated", "integrated"]);
  expect(run.delegations).toHaveLength(5);
  expect(
    run.delegations.every(
      (edge) =>
        edge.agentId &&
        edge.phase === "settled" &&
        h.daemon.store.getThread(ThreadId.parse(edge.threadId))?.status.state === "done",
    ),
  ).toBe(true);
  const worker = h.sends.filter((entry) => entry.text.includes("Implement this workstream"));
  expect(new Set(worker.map((entry) => entry.cwd)).size).toBe(2);
  expect(worker.every((entry) => entry.cwd !== h.repo)).toBe(true);
  const second = worker.at(-1);
  if (!second) throw new Error("Second worker missing");
  expect(git(second.cwd, "show", "HEAD:a.txt")).toBe("a works");
  expect(git(h.repo, "rev-parse", "HEAD")).toBe(h.original);
  expect(h.sends.some((entry) => entry.text.includes("delegated child"))).toBe(false);
  expect(run.startedAt).toBeGreaterThan(0);
  expect(run.updatedAt).toBeGreaterThanOrEqual(run.startedAt);
});

test("a plan gate pushes needsUser and no worker starts until the human approves", async () => {
  const h = await deckFixture({ planApproval: "required", hold: true });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await expect.poll(() => h.changes.at(-1)?.needsUser[0]?.kind).toBe("plan");
  const gated = await h.read();
  const gate = gated.needsUser[0];
  if (!gate) throw new Error("Plan gate missing");
  expect(gate.gatedAt).toBeGreaterThanOrEqual(gated.startedAt);
  const parent = gated.delegations[0]?.parentThreadId;
  if (!parent) throw new Error("Deck root missing");
  await expect
    .poll(() => h.daemon.store.getThread(ThreadId.parse(parent))?.status.state)
    .toBe("needs_you");
  expect(h.sends.filter((entry) => entry.text.includes("Implement this workstream"))).toHaveLength(
    0,
  );
  h.release();
  expect(
    await h.commands({
      type: "conductor.approve",
      runId: h.runId,
      approval: { gateId: gate.id, decision: "approve" },
    }),
  ).toMatchObject({ ok: true });
  await expect.poll(() => h.changes.at(-1)?.phase).toBe("done");
  expect((await h.read()).needsUser).toEqual([]);
});

test("a provider question appears in needsUser and answering its real interaction resumes the card", async () => {
  const h = await deckFixture({ question: true });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await expect
    .poll(() => h.changes.at(-1)?.needsUser.some((gate) => gate.kind === "provider"))
    .toBe(true);
  const gate = (await h.read()).needsUser.find((entry) => entry.kind === "provider");
  if (!gate?.interactionId || !gate.threadId) throw new Error("Provider question missing");
  expect(h.daemon.store.getInteraction(gate.interactionId)?.state).toBe("pending");
  expect((await h.read()).phase).toBe("running");
  expect(
    await h.commands({
      type: "interaction.resolve",
      interactionId: InteractionId.parse(gate.interactionId),
      resolution: { kind: "question", answers: { choice: ["yes"] } },
    }),
  ).toMatchObject({ ok: true });
  await expect.poll(() => h.changes.at(-1)?.phase).toBe("done");
});

test("cancel stops a lane and its streaming delegate_task subtree before publishing cancelled", async () => {
  const h = await deckFixture({ hold: true, stallAfterMs: 1500 });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await expect
    .poll(() => h.sends.some((entry) => entry.text.includes("Implement this workstream")))
    .toBe(true);
  const lane = (await h.read()).delegations.find((edge) => edge.workstream === "a");
  if (!lane?.agentId || !h.daemon.agentControl) throw new Error("Worker missing");
  const caller: McpAttribution = {
    sessionId: "scripted",
    threadId: ThreadId.parse(lane.threadId),
    agentId: AgentId.parse(lane.agentId),
  };
  const child = h.daemon.agentControl.delegations.delegate(caller, {
    requestId: "nested",
    provider: "codex",
    task: "Hold nested task",
    role: "nested",
    wait: false,
    estimatedLoad: 0,
  });
  await h.daemon.engine?.flush();
  await expect
    .poll(() => h.changes.at(-1)?.delegations.some((edge) => edge.threadId === child.childId))
    .toBe(true);
  await h.finish(ThreadId.parse(lane.threadId));
  await h.daemon.engine?.flush();
  expect(h.daemon.store.getThread(ThreadId.parse(lane.threadId))?.status.state).not.toBe("done");
  expect((await h.read()).phase).toBe("running");
  await h.beginStream(child.childId);
  for (let index = 0; index < 10; index++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await h.stream(child.childId, " still working");
  }
  expect((await h.read()).needsUser).toEqual([]);
  expect(await h.commands({ type: "conductor.cancel", runId: h.runId })).toMatchObject({
    ok: true,
  });
  await expect.poll(() => h.changes.at(-1)?.phase).toBe("cancelled");
  expect(h.daemon.store.getThread(child.childId)?.status.state).toBe("done");
  expect(h.daemon.agentControl.delegations.journal.get(child.childId)?.outcome?.outcome).toBe(
    "cancelled",
  );
  expect(() =>
    h.daemon.agentControl?.delegations.delegate(caller, {
      requestId: "late",
      provider: "codex",
      task: "Must not start",
      role: "nested",
      wait: false,
      estimatedLoad: 0,
    }),
  ).toThrow(/cancelled/);
});

test("restart recovers an in-flight Deck with an empty conductor outbox and preserves lane identities", async () => {
  const h = await deckFixture({ hold: true });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await expect
    .poll(() => h.sends.some((entry) => entry.text.includes("Implement this workstream")))
    .toBe(true);
  const before = await h.read();
  const lane = before.delegations.find((edge) => edge.workstream === "a");
  if (!lane) throw new Error("Worker missing");
  h.release();
  await h.restart();
  await h.subscribe();
  await expect.poll(() => h.changes.at(-1)?.phase).toBe("done");
  const after = await h.read();
  expect(after.startedAt).toBe(before.startedAt);
  expect(after.delegations.filter((edge) => edge.threadId === lane.threadId)).toHaveLength(1);
  expect(h.sends.filter((entry) => entry.thread === lane.threadId && entry.resumed)).toHaveLength(
    1,
  );
  expect(h.sends.filter((entry) => entry.thread === lane.threadId && !entry.resumed)).toHaveLength(
    1,
  );
});

test("host capacity admits one live card at a time even when the Deck requests more", async () => {
  const h = await deckFixture({
    hold: true,
    parallel: 4,
    hostCapacity: 1,
    cards: plan({ a: [], b: [] }),
  });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await expect
    .poll(() => h.changes.at(-1)?.lanes.filter((lane) => lane.role === "worker").length)
    .toBe(1);
  const first = h.sends.find((entry) => entry.text.includes("Implement this workstream"));
  if (!first) throw new Error("Worker missing");
  expect(h.sends.filter((entry) => entry.text.includes("Implement this workstream"))).toHaveLength(
    1,
  );
  h.release();
  await h.finish(first.thread);
  await expect.poll(() => h.changes.at(-1)?.phase).toBe("done");
  expect(h.sends.filter((entry) => entry.text.includes("Implement this workstream"))).toHaveLength(
    2,
  );
  expect(h.changes.every((run) => run.lanes.length <= 1)).toBe(true);
});

test("pausing preserves a lane continuation and resume does not leave subtree cancellation markers", async () => {
  const h = await deckFixture({ hold: true });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await expect
    .poll(() => h.sends.some((entry) => entry.text.includes("Implement this workstream")))
    .toBe(true);
  const lane = (await h.read()).delegations.find((edge) => edge.workstream === "a");
  if (!lane) throw new Error("Worker missing");
  const thread = ThreadId.parse(lane.threadId);
  expect(await h.commands({ type: "conductor.pause", runId: h.runId })).toMatchObject({ ok: true });
  await expect.poll(() => h.daemon.engine?.queuePage({ threadId: thread }).paused).toBe(true);
  await h.daemon.engine?.flush();
  expect((await h.read()).phase).toBe("paused");
  expect(h.daemon.agentControl?.delegations.journal.stopped(thread)).toBe(false);
  h.release();
  expect(await h.commands({ type: "conductor.resume", runId: h.runId })).toMatchObject({
    ok: true,
  });
  await expect.poll(() => h.changes.at(-1)?.phase).toBe("done");
  expect(h.sends.filter((entry) => entry.thread === thread && entry.resumed)).toHaveLength(1);
});

test("restart restores a human gate without starting a worker or changing its timestamp", async () => {
  const h = await deckFixture({ planApproval: "required" });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await expect.poll(() => h.changes.at(-1)?.needsUser[0]?.kind).toBe("plan");
  const gate = (await h.read()).needsUser[0];
  if (!gate) throw new Error("Plan gate missing");
  await h.restart();
  await h.subscribe();
  expect((await h.read()).needsUser[0]).toMatchObject({ id: gate.id, gatedAt: gate.gatedAt });
  expect(h.sends.filter((entry) => entry.text.includes("Implement this workstream"))).toHaveLength(
    0,
  );
  expect(
    await h.commands({
      type: "conductor.approve",
      runId: h.runId,
      approval: { gateId: gate.id, decision: "approve" },
    }),
  ).toMatchObject({ ok: true });
  await expect.poll(() => h.changes.at(-1)?.phase).toBe("done");
});

test("PR-only waits for CI at the published revision and recovers a lost create response without a duplicate PR", async () => {
  const h = await deckFixture({ prOnly: true });
  h.forge.loseResponse();
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await expect.poll(() => h.forge.publications.length).toBe(1);
  await expect.poll(() => h.changes.at(-1)?.executionError).toBeTruthy();
  expect((await h.read()).phase).not.toBe("done");
  await h.restart();
  await h.subscribe();
  await expect.poll(() => h.changes.at(-1)?.dag[0]?.state).toBe("verifying");
  expect(h.forge.publications).toHaveLength(1);
  expect((await h.read()).phase).not.toBe("done");
  h.forge.pass();
  await expect.poll(() => h.changes.at(-1)?.phase).toBe("done");
  expect(h.forge.publications).toHaveLength(1);
  expect(git(h.repo, "rev-parse", "HEAD")).toBe(h.original);
});

test("an invalid review revision cannot pass or block the missing-artifact human escalation", async () => {
  const h = await deckFixture({ wrongReviewRevision: true, stallAfterMs: 100 });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await expect
    .poll(() => h.changes.at(-1)?.needsUser.some((gate) => gate.kind === "escalation"))
    .toBe(true);
  expect((await h.read()).phase).not.toBe("done");
  expect((await h.read()).dag[0]?.state).not.toBe("integrated");
});

test("a recoverable local quota hold resumes through the engine without resending the original task", async () => {
  const h = await deckFixture({ quotaLimit: true });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await expect.poll(() => h.changes.at(-1)?.phase).toBe("done");
  const worker = (await h.read()).delegations.find(
    (edge) =>
      edge.workstream === "a" &&
      h.sends.some(
        (send) => send.thread === edge.threadId && send.text.includes("Implement this workstream"),
      ),
  );
  if (!worker) throw new Error("Worker missing");
  expect(h.sends.filter((send) => send.thread === worker.threadId && !send.resumed)).toHaveLength(
    1,
  );
  expect(h.sends.filter((send) => send.thread === worker.threadId && send.resumed)).toHaveLength(1);
});
