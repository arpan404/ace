import { afterEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { AgentId, ThreadId } from "@ace/protocol";
import { closeDeckFixtures, deckFixture } from "./test-support.ts";
afterEach(closeDeckFixtures);

test("workspace and thread lists retain Deck ownership across a restart including delegated children", async () => {
  const h = await deckFixture({ hold: true });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((run) =>
    run.lanes.some((lane) => lane.role === "worker" && lane.status === "working"),
  );
  await h.settle();
  const worker = (await h.read()).delegations.find((edge) => edge.workstream === "a");
  if (!worker?.agentId || !h.daemon.agentControl) throw new Error("Worker missing");
  const child = h.daemon.agentControl.delegations.delegate(
    {
      threadId: ThreadId.parse(worker.threadId),
      agentId: AgentId.parse(worker.agentId),
      sessionId: "scripted",
    },
    {
      requestId: "ownership-child",
      role: "nested",
      task: "Hold child",
      provider: "codex",
      wait: false,
      estimatedLoad: 0,
    },
  );
  await h.settle();
  for (let index = 0; index < 2; index++) {
    const subscriptionId = randomUUID();
    const snapshot = await h.request(
      { type: "subscribe", subscriptionId, scope: { kind: "threads" } },
      (reply) => reply.type === "snapshot" && reply.subscriptionId === subscriptionId,
    );
    if (snapshot.type !== "snapshot" || snapshot.view.kind !== "threads")
      throw new Error("Thread list missing");
    const owned = Object.values(snapshot.view.threads).filter(
      (thread) => thread.deck?.runId === h.runId,
    );
    expect(owned.map((thread) => thread.deck?.role).toSorted()).toEqual([
      "delegate",
      "planner",
      "root",
      "worker",
    ]);
    expect(snapshot.view.threads[child.childId]?.deck).toMatchObject({
      deckId: h.runId,
      runId: h.runId,
      role: "delegate",
      laneId: worker.laneId,
      workspaceId: h.spec.workspaceId,
    });
    const requestId = randomUUID();
    const result = await h.request(
      { type: "workspace.request", requestId, operation: { op: "workspaces.list", limit: 100 } },
      (reply) => reply.type === "workspace.result" && reply.requestId === requestId,
    );
    if (result.type !== "workspace.result" || result.result.kind !== "workspaces")
      throw new Error("Workspace list missing");
    expect(
      result.result.workspaces.find((workspace) => workspace.id === h.spec.workspaceId)?.deck,
    ).toBeUndefined();
    const lanes = result.result.workspaces.filter((workspace) => workspace.deck?.runId === h.runId);
    expect(lanes.map((workspace) => workspace.deck?.role).toSorted()).toEqual([
      "planner",
      "worker",
    ]);
    expect(
      lanes.every(
        (workspace) =>
          workspace.deck?.deckId === h.runId &&
          workspace.deck.workspaceId === h.spec.workspaceId &&
          workspace.deck.laneId,
      ),
    ).toBe(true);
    if (index === 0) {
      await h.restart();
      await h.subscribe();
      await h.settle();
    }
  }
  expect(await h.commands({ type: "conductor.cancel", runId: h.runId })).toMatchObject({
    ok: true,
  });
  await h.waitFor((run) => run.phase === "cancelled");
});
