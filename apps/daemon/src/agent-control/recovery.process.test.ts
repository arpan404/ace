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

test("daemon crash holds a live delegation until explicit native recovery without replaying its input", async () => {
  const h = setup();
  const parent = await h.parent();
  const edge = h.delegate(parent, "crash");
  await h.engine.flush();
  const nativeSessionId = [...h.nativeHistories.keys()].find((id) =>
    id.startsWith("native-claude-"),
  );
  if (!nativeSessionId) throw new Error("Missing child native history");
  const snapshot = join(h.home, "crash.sqlite");
  let sourceDb: DatabaseSync | undefined;
  h.store.atomic((db) => {
    sourceDb = db;
  });
  if (!sourceDb) throw new Error("Missing snapshot source");
  await backup(sourceDb, snapshot);
  await h.close();
  const recovered = setup({}, snapshot);
  recovered.clock.advance(1050);
  await recovered.engine.flush();
  expect(recovered.engine.queue(edge.childId)).toMatchObject({ paused: true, reason: "restart" });
  expect(recovered.store.getThread(edge.childId)?.status).toEqual({
    state: "waiting",
    on: "queue",
  });
  expect(recovered.store.getThread(parent.threadId)?.status.state).not.toBe("done");
  expect(recovered.engine.queue(parent.threadId).paused).toBe(false);
  expect(recovered.contexts.has(edge.childId)).toBe(false);
  expect(wakes(recovered.events, parent.threadId)).toHaveLength(0);
  expect(
    recovered.service.command("recover-child", {
      type: "thread.resume",
      threadId: edge.childId,
      expectedRevision: recovered.engine.queue(edge.childId).revision,
    }).ok,
  ).toBe(true);
  await recovered.engine.flush();
  expect(recovered.contexts.get(edge.childId)?.resume).toEqual({
    nativeSessionId,
  });
  expect(recovered.inputs.get(edge.childId)?.join("\n")).toContain("Continue the interrupted task");
  expect(recovered.inputs.get(edge.childId)?.join("\n")).not.toContain("Implement safely");
  await recovered.complete(edge.childId, "recovered completion");
  recovered.clock.advance(1100);
  await recovered.engine.flush();
  const outcome = await recovered.service.wait(parent, edge.childId, new AbortController().signal);
  expect(outcome.outcome).toBe("completed");
  expect(wakes(recovered.events, parent.threadId)).toHaveLength(1);
});
