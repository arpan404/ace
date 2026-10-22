import { join } from "node:path";
import { backup, type DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { setup, wakes } from "./test-support.ts";

test("durable pending results survive service restart and are consumed exactly once", async () => {
  const h = setup();
  const parent = await h.parent();
  const edge = h.delegate(parent, "recover-result");
  await h.engine.flush();
  await h.complete(edge.childId, "retained");
  h.restartOwner();
  h.clock.advance(1050);
  await h.engine.flush();
  expect(wakes(h.events, parent.threadId)).toHaveLength(1);
  h.restartOwner();
  h.clock.advance(1100);
  await h.engine.flush();
  expect(wakes(h.events, parent.threadId)).toHaveLength(1);
});

/** Snapshot the daemon database as a crash would leave it, and start a fresh daemon on it. */
async function crash(h: ReturnType<typeof setup>, policy: Parameters<typeof setup>[0] = {}) {
  const snapshot = join(h.home, "crash.sqlite");
  let sourceDb: DatabaseSync | undefined;
  h.store.atomic((db) => {
    sourceDb = db;
  });
  if (!sourceDb) throw new Error("Missing snapshot source");
  await backup(sourceDb, snapshot);
  await h.close();
  const recovered = setup(policy, snapshot);
  recovered.clock.advance(1050);
  await recovered.engine.flush();
  return recovered;
}
const restartInput = (value: string) => value.startsWith("ace restarted while you were working");
const statusesOf = (h: ReturnType<typeof setup>, thread: string) =>
  h.events.flatMap((event) =>
    event.threadId === thread && event.payload.type === "thread.updated" && event.payload.status
      ? [event.payload.status.state]
      : [],
  );

test("a delegated child a crash cut short continues by itself and its parent never sees it settle early", async () => {
  const h = setup();
  const parent = await h.parent();
  const edge = h.delegate(parent, "crash");
  await h.engine.flush();
  const nativeSessionId = [...h.nativeHistories.keys()].find((id) =>
    id.startsWith("native-claude-"),
  );
  if (!nativeSessionId) throw new Error("Missing child native history");
  const recovered = await crash(h);

  // The child reopens its own session with one restart continuation, never its task again.
  expect(recovered.contexts.get(edge.childId)?.resume).toEqual({ nativeSessionId });
  expect(recovered.inputs.get(edge.childId)?.map(restartInput)).toEqual([true]);
  expect(recovered.store.getThread(edge.childId)?.status.state).toBe("working");
  expect(recovered.store.getThread(parent.threadId)?.status.state).not.toBe("done");
  // While it works, the parent has no result: no wake, and a bounded wait times out.
  expect(wakes(recovered.events, parent.threadId)).toHaveLength(0);
  const waited = recovered.service.waitBounded(
    parent,
    edge.childId,
    new AbortController().signal,
    50,
  );
  recovered.clock.advance(recovered.clock.now() + 50);
  expect(await waited).toBeUndefined();
  expect(statusesOf(recovered, edge.childId)).not.toContain("done");
  expect(statusesOf(recovered, edge.childId)).not.toContain("failed");

  await recovered.complete(edge.childId, "recovered completion");
  recovered.clock.advance(recovered.clock.now() + 1100);
  await recovered.engine.flush();
  const outcome = await recovered.service.wait(parent, edge.childId, new AbortController().signal);
  expect(outcome).toMatchObject({ outcome: "completed", result: "recovered completion" });
  expect(wakes(recovered.events, parent.threadId)).toHaveLength(1);
});

test("a child whose provider died gives its slot to the next queued child", async () => {
  const h = setup({ maxConcurrent: 1 });
  const parent = await h.parent();
  const dead = h.delegate(parent, "dead");
  await h.engine.flush();
  const queued = h.delegate(parent, "queued");
  await h.engine.flush();
  expect(h.contexts.has(queued.childId)).toBe(false);

  h.contexts.get(dead.childId)?.onExit({ deliberate: false, message: "provider died" });
  await h.engine.flush();

  expect(h.engine.queue(dead.childId)).toMatchObject({ paused: true, reason: "restart" });
  expect(h.inputs.get(queued.childId)?.join("\n")).toContain("Implement safely");
  expect(h.store.getThread(queued.childId)?.status.state).toBe("working");
  // The dead child is held for someone, never reported finished to its parent.
  expect(h.store.getThread(dead.childId)?.status.state).not.toBe("done");
  expect(wakes(h.events, parent.threadId)).toHaveLength(0);
});

test("after a restart, a child ace won't continue frees its slot and the queued child starts", async () => {
  const h = setup({ maxConcurrent: 1 });
  const parent = await h.parent();
  const held = h.delegate(parent, "held");
  await h.engine.flush();
  const queued = h.delegate(parent, "queued");
  await h.engine.flush();
  // The held child was waiting on the person when ace stopped, so it doesn't resume.
  await h.emit(held.childId, {
    type: "interaction.opened",
    agent: "root",
    interaction: "approval",
    blocking: true,
    request: {
      kind: "approval",
      title: "Run the migration?",
      options: [{ id: "yes", label: "Yes", kind: "allow_once" }],
    },
  });
  expect(h.contexts.has(queued.childId)).toBe(false);
  const recovered = await crash(h, { maxConcurrent: 1 });

  expect(recovered.engine.queue(held.childId)).toMatchObject({ paused: true, reason: "restart" });
  expect(recovered.inputs.get(held.childId)).toBeUndefined();
  expect(recovered.inputs.get(queued.childId)?.join("\n")).toContain("Implement safely");
  expect(recovered.store.getThread(held.childId)?.status.state).not.toBe("done");
  expect(recovered.store.getThread(parent.threadId)?.status.state).not.toBe("done");
});
