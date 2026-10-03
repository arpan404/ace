import { expect, test } from "vitest";
import { createAgentControlPort } from "@ace/daemon";
import { ToolRegistry, agentControlToolkit } from "@ace/mcp-server";
import { DelegationRequest } from "@ace/protocol";
import { setup, wakes } from "./test-support.ts";

// Written before the production fix. Execution is reserved for merge by owner policy.
test.each([1, 2])(
  "a settled descendant %s levels below a stopped ancestor cannot prepare children through its surviving MCP scope",
  async (distance) => {
    const h = setup(
      { maxConcurrent: 1, maxChildren: distance + 2 },
      undefined,
      false,
      undefined,
      false,
      undefined,
      distance + 2,
    );
    const parent = await h.parent();
    const a = h.delegate(parent, "a");
    await h.engine.flush();
    const b = h.delegate(h.caller(a.childId), "b");
    await h.engine.flush();
    const settled = [b];
    if (distance === 2) {
      const c = h.delegate(h.caller(b.childId), "c");
      await h.engine.flush();
      await h.complete(c.childId, "finished grandchild");
      settled.push(c);
    }
    await h.complete(b.childId, "finished before the interruption");
    const leaf = settled.at(-1);
    if (!leaf) throw new Error("Missing descendant");
    const caller = h.caller(leaf.childId);
    const signal = h.contexts.get(leaf.childId)?.signal;
    const originalCount = distance + 2;
    const ids = [parent.threadId, a.childId, ...settled.map((child) => child.childId)];
    if (!signal) throw new Error("Missing surviving native session");
    expect(
      h.service.command("stop-a", { type: "thread.interrupt", threadId: a.childId, cascade: true })
        .ok,
    ).toBe(true);
    await h.engine.flush();
    h.restartOwner();
    h.clock.advance(1050);
    await h.engine.flush();
    h.clock.advance(2050);
    await h.engine.flush();
    expect(h.errors).toEqual([]);
    for (const child of settled) expect(wakes(h.events, child.childId)).toHaveLength(0);
    expect(signal.aborted).toBe(false);
    for (const id of ids) expect(h.store.getThread(id)?.status.state).toBe("done");
    const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
    agentControlToolkit(createAgentControlPort(h.store, h.service)).register(registry);
    const create = (requestId: string) =>
      registry.call(
        "ace_thread_create",
        {
          requestId,
          provider: "claude",
          title: "late child",
        },
        { scope: { ...caller, capabilities: ["thread_control"] }, signal },
        signal,
      );
    for (const requestId of ["late-one", "late-two", "late-three"]) {
      expect((await create(requestId)).isError).toBe(true);
      expect(h.store.listThreads()).toHaveLength(originalCount);
      expect(
        Object.values(h.store.snapshotThread(leaf.childId).agents).some(
          (agent) => agent.childThreadId !== undefined,
        ),
      ).toBe(false);
      for (const id of ids) expect(h.store.getThread(id)?.status.state).toBe("done");
    }
    // Denials cannot spend the remaining receipt/tree slot. Explicitly reopen A first.
    expect(h.service.message(parent, "resume-a", a.childId, "continue", "queue").ok).toBe(true);
    await h.engine.flush();
    const accepted = await create("late-one");
    expect(accepted.isError).not.toBe(true);
    expect(accepted.structuredContent).toMatchObject({ ok: true });
    expect(h.store.listThreads()).toHaveLength(originalCount + 1);
    expect(
      Object.values(h.store.snapshotThread(leaf.childId).agents).some(
        (agent) => agent.childThreadId !== undefined,
      ),
    ).toBe(true);
  },
);

test("a reservation made before ancestor interruption cannot commit a prepared child after the stop", async () => {
  const h = setup(
    { maxConcurrent: 1, maxChildren: 3 },
    undefined,
    false,
    undefined,
    false,
    undefined,
    3,
  );
  const parent = await h.parent();
  const a = h.delegate(parent, "a");
  await h.engine.flush();
  const b = h.delegate(h.caller(a.childId), "b");
  await h.engine.flush();
  await h.complete(b.childId, "finished");
  const caller = h.caller(b.childId);
  const workspace = h.store.getThread(b.childId)?.workspaceId;
  if (!workspace) throw new Error("Missing workspace");
  const request = DelegationRequest.parse({
    requestId: "reserved",
    provider: "claude",
    task: "late work",
    role: "worker",
  });
  const reservation = h.service.reserve(caller, request);
  expect(
    h.service.command("stop-a", { type: "thread.interrupt", threadId: a.childId, cascade: true })
      .ok,
  ).toBe(true);
  await h.engine.flush();
  h.restartOwner();
  h.clock.advance(1050);
  await h.engine.flush();
  expect(() => h.service.prepareReserved(caller, reservation, workspace)).toThrow(/cancelled/);
  expect(h.store.listThreads()).toHaveLength(3);
  expect(h.store.getThread(reservation.record.childId)).toBeUndefined();
  expect(
    Object.values(h.store.snapshotThread(b.childId).agents).some(
      (agent) => agent.childThreadId !== undefined,
    ),
  ).toBe(false);
  for (const id of [parent.threadId, a.childId, b.childId])
    expect(h.store.getThread(id)?.status.state).toBe("done");
  h.service.releaseReservation(reservation);
  expect(() => h.service.reserve(caller, request)).toThrow(/cancelled/);
  // The host's released reservation is reusable once the ancestor is explicitly reopened.
  expect(h.service.message(parent, "resume-a", a.childId, "continue", "queue").ok).toBe(true);
  await h.engine.flush();
  const child = h.service.prepareInWorkspace(caller, request, workspace);
  expect(h.store.getThread(child.childId)).toBeDefined();
  expect(h.store.listThreads()).toHaveLength(4);
});
