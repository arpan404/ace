import { expect, test } from "vitest";
import { Command, ThreadId } from "@ace/protocol";
import { ThreadLifecycle } from "../thread-lifecycle.ts";
import { setup } from "./test-support.ts";

test.each([64, 2])(
  "a full accepted delegation history remains traversable and deletable with %i active slots",
  async (maxActiveThreads) => {
    const f = setup(
      { durationMs: 86400000 },
      undefined,
      false,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      { maxActiveThreads },
    );
    const parent = await f.parent();
    const ids = [parent.threadId];
    for (let child = 0; child < 64; child++) {
      const edge = f.delegate(parent, `child-${child}`, true);
      ids.push(edge.childId);
      await f.engine.flush();
      await f.complete(edge.childId, `Result ${child}`);
      expect(
        await f.service.wait(parent, edge.childId, new AbortController().signal),
      ).toMatchObject({ outcome: "completed", result: `Result ${child}` });
      // Retire idle sessions independently of the durable ownership history.
      f.clock.advance(f.clock.now() + 100001);
      await f.engine.flush();
    }
    expect(f.engine.cleanupThreads(parent.threadId)).toEqual(ids);
    expect(f.engine.liveWork(parent.threadId)).toEqual({ agentsRunning: 0, operationsRunning: 0 });
    const lifecycle = new ThreadLifecycle({
      store: f.store,
      engine: f.engine,
      handler: f.engine.handler,
      port: 0,
      hostId: "test",
      token: "unused",
      now: f.clock.now,
    });
    expect(
      await lifecycle.delete(
        Command.parse({
          id: "delete-history",
          deviceId: "test",
          payload: { type: "thread.delete", threadId: parent.threadId },
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(f.store.getThread(parent.threadId)?.deletedAt).toBeDefined();
    expect(f.errors).toEqual([]);
  },
);

test("forced deletion owns the full nested history and stops a resumed last child", async () => {
  const f = setup({ durationMs: 86400000 });
  const parent = await f.parent();
  const branch = f.delegate(parent, "branch", true);
  await f.engine.flush();
  const children = [branch.childId];
  for (let child = 0; child < 63; child++) {
    const edge = f.delegate(f.caller(branch.childId), `nested-${child}`, true);
    children.push(edge.childId);
    await f.engine.flush();
    await f.complete(edge.childId, "Done");
    await f.service.wait(f.caller(branch.childId), edge.childId, new AbortController().signal);
    f.clock.advance(f.clock.now() + 100001);
    await f.engine.flush();
  }
  await f.complete(branch.childId, "Branch done");
  await f.service.wait(parent, branch.childId, new AbortController().signal);
  const last = children.at(-1);
  if (!last) throw new Error("Missing child");
  expect(f.service.message(parent, "resume-last", last, "Continue", "queue").ok).toBe(true);
  await f.engine.flush();
  expect(f.engine.liveWork(parent.threadId).agentsRunning).toBeGreaterThan(0);
  const lifecycle = new ThreadLifecycle({
    store: f.store,
    engine: f.engine,
    handler: f.engine.handler,
    port: 0,
    hostId: "test",
    token: "unused",
    now: f.clock.now,
  });
  expect(
    await lifecycle.delete(
      Command.parse({
        id: "force-history",
        deviceId: "test",
        payload: { type: "thread.delete", threadId: parent.threadId, force: true },
      }),
    ),
  ).toMatchObject({ ok: true });
  expect(f.engine.liveWork(parent.threadId)).toEqual({ agentsRunning: 0, operationsRunning: 0 });
  expect(f.store.getThread(parent.threadId)?.deletedAt).toBeDefined();
  expect(f.store.getThread(last)?.status.state).toBe("done");
});

test("cyclic ownership is visited once and oversized malformed ownership fails with a bound", async () => {
  const f = setup();
  const parent = await f.parent();
  const child = f.delegate(parent, "child", true);
  await f.engine.flush();
  const root = f.store.getThread(parent.threadId);
  if (!root) throw new Error("Missing root");
  f.engine.attachChild(child.childId, f.caller(child.childId).agentId, root, "cycle", false);
  expect(f.engine.cleanupThreads(parent.threadId)).toEqual([parent.threadId, child.childId]);
  for (let index = 0; index < 64; index++) {
    const id = ThreadId.parse(`malformed-${index}`);
    expect(
      f.service.command(`prepare-${index}`, {
        type: "thread.prepare",
        title: "Malformed ownership node",
        threadId: id,
        workspaceId: root.workspaceId,
        provider: "claude",
      }).ok,
    ).toBe(true);
    const malformed = f.store.getThread(id);
    if (!malformed) throw new Error("Missing malformed child");
    f.engine.attachChild(parent.threadId, parent.agentId, malformed, "malformed", false);
  }
  expect(() => f.engine.cleanupThreads(parent.threadId)).toThrow("Thread tree exceeds capacity");
});
