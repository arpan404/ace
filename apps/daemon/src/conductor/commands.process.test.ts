import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { ConductorSpec, InteractionId, ThreadId } from "@ace/protocol";
import { closeDeckFixtures, deckFixture } from "./test-support.ts";

afterEach(closeDeckFixtures);

test("worker command ids pause, resume, redraft, approve and replay across restart", async () => {
  const h = await deckFixture({ planApproval: "required" });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  const first = await h.waitFor((run) => run.needsUser.some((gate) => gate.kind === "plan"));
  const gate = first.needsUser.find((entry) => entry.kind === "plan");
  if (!gate) throw new Error("Plan gate missing");
  expect(await h.commands({ type: "conductor.pause", runId: h.runId })).toMatchObject({ ok: true });
  expect((await h.read()).phase).toBe("paused");
  expect(await h.commands({ type: "conductor.resume", runId: h.runId })).toMatchObject({
    ok: true,
  });
  expect((await h.read()).phase).toBe("planning");
  expect(
    await h.commands({
      type: "conductor.approve",
      runId: h.runId,
      approval: { gateId: gate.id, decision: "reject" },
    }),
  ).toMatchObject({ ok: true });
  const second = await h.waitFor((run) =>
    run.needsUser.some((entry) => entry.kind === "plan" && entry.id !== gate.id),
  );
  const next = second.needsUser.find((entry) => entry.kind === "plan");
  if (!next) throw new Error("Redrafted plan missing");
  const approval = {
    type: "conductor.approve" as const,
    runId: h.runId,
    approval: { gateId: next.id, decision: "approve" as const },
  };
  const id = `${randomUUID()}:41`;
  expect(await h.commands(approval, id)).toMatchObject({ ok: true });
  await h.waitFor((run) => run.phase === "done");
  await h.restart();
  expect(await h.commands(approval, id)).toMatchObject({ ok: true });
  expect((await h.read()).phase).toBe("done");
});

test("worker command ids cancel a gated run without launching workers", async () => {
  const h = await deckFixture({ planApproval: "required" });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((run) => run.needsUser.some((gate) => gate.kind === "plan"));
  expect(await h.commands({ type: "conductor.cancel", runId: h.runId })).toMatchObject({
    ok: true,
  });
  expect((await h.read()).phase).toBe("cancelled");
  expect(h.sends.some((entry) => entry.text.includes("Implement this workstream"))).toBe(false);
});

test("worker command ids approve the mirrored plan on its root thread", async () => {
  const h = await deckFixture({ planApproval: "required" });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  const run = await h.waitFor((view) => view.needsUser.some((gate) => gate.kind === "plan"));
  await h.settle();
  const root = run.delegations[0]?.parentThreadId;
  if (!root) throw new Error("Root thread missing");
  const interaction = Object.values(
    h.daemon.store.acquireThread(ThreadId.parse(root)).interactions,
  ).find((entry) => entry.state === "pending");
  h.daemon.store.releaseThread(ThreadId.parse(root));
  if (!interaction) throw new Error("Mirrored plan missing");
  expect(
    await h.commands({
      type: "interaction.resolve",
      interactionId: InteractionId.parse(interaction.id),
      resolution: { kind: "plan_review", decision: "approve" },
    }),
  ).toMatchObject({ ok: true });
  await h.waitFor((view) => view.phase === "done");
});

test("stale decisions return the reducer refusal and leave the current gate open", async () => {
  const h = await deckFixture({ planApproval: "required" });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((view) => view.needsUser.some((gate) => gate.kind === "plan"));
  expect(
    await h.commands({
      type: "conductor.approve",
      runId: h.runId,
      approval: { gateId: "gone", decision: "approve" },
    }),
  ).toMatchObject({ ok: false, error: "gate_not_pending" });
  expect((await h.read()).needsUser.some((gate) => gate.kind === "plan")).toBe(true);
});

test("a budget approval must increase the budget before the planner can launch", async () => {
  const h = await deckFixture();
  const roles = Object.fromEntries(
    Object.entries(h.spec.policies.roles).map(([role, models]) => [
      role,
      models.map((model) => ({ ...model, cost: 1 })),
    ]),
  );
  const spec = ConductorSpec.parse({
    ...h.spec,
    constraints: { ...h.spec.constraints, budget: 0 },
    policies: { ...h.spec.policies, roles },
  });
  expect(await h.commands({ type: "conductor.start", runId: h.runId, spec })).toMatchObject({
    ok: true,
  });
  await h.subscribe();
  const run = await h.waitFor((view) => view.needsUser.some((gate) => gate.kind === "budget"));
  const gate = run.needsUser.find((entry) => entry.kind === "budget");
  if (!gate) throw new Error("Budget gate missing");
  expect(
    await h.commands({
      type: "conductor.approve",
      runId: h.runId,
      approval: { gateId: gate.id, decision: "approve", budget: 0 },
    }),
  ).toMatchObject({ ok: false, error: "budget_must_increase" });
  expect(
    await h.commands({
      type: "conductor.approve",
      runId: h.runId,
      approval: { gateId: gate.id, decision: "approve", budget: 100 },
    }),
  ).toMatchObject({ ok: true });
  await h.waitFor((view) => view.phase === "done");
});

test("retry after the conductor commit but before the daemon receipt keeps the redrafted plan", async () => {
  const h = await deckFixture({ planApproval: "required" });
  await h.startRun();
  await h.subscribe();
  const first = await h.waitFor((run) => run.needsUser.some((gate) => gate.kind === "plan"));
  const gate = first.needsUser.find((entry) => entry.kind === "plan");
  if (!gate) throw new Error("Plan missing");
  const id = `${randomUUID()}:9`;
  const decision = {
    type: "conductor.approve" as const,
    runId: h.runId,
    approval: { gateId: gate.id, decision: "reject" as const },
  };
  expect(await h.commands(decision, id)).toMatchObject({ ok: true });
  const redrafted = await h.waitFor((run) =>
    run.needsUser.some((entry) => entry.kind === "plan" && entry.id !== gate.id),
  );
  const nextGate = redrafted.needsUser.find((entry) => entry.kind === "plan");
  // Model a crash between commits in the two real SQLite journals.
  h.daemon.store.atomic((db) =>
    db.prepare("DELETE FROM command_receipts WHERE command_id=?").run(id),
  );
  await h.restart();
  expect(await h.commands(decision, id)).toMatchObject({ ok: true });
  const after = await h.read();
  expect(after.needsUser.find((entry) => entry.kind === "plan")?.id).toBe(nextGate?.id);
  expect(h.sends.filter((entry) => entry.text.includes("Plan this project"))).toHaveLength(2);
});

test("worker-style resume retries a pending CI step and finishes at its reviewed revision", async () => {
  const h = await deckFixture({ prOnly: true });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  const pending = await h.waitFor((run) => run.executionError === "deck_ci_pending");
  expect(pending.phase).toBe("running");
  expect(pending.dag[0]?.state).toBe("verifying");
  h.forge.pass();
  expect(await h.commands({ type: "conductor.resume", runId: h.runId })).toMatchObject({
    ok: true,
  });
  const done = await h.waitFor((run) => run.phase === "done");
  expect(done.executionError).toBeUndefined();
  expect(done.dag[0]?.state).toBe("integrated");
  expect(h.forge.publications).toHaveLength(1);
});
