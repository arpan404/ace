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

test("daemon crash snapshot recovers a live delegation as uncertain failure without replaying its child", async () => {
  const h = setup();
  const parent = await h.parent();
  const edge = h.delegate(parent, "crash");
  await h.engine.flush();
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
  const outcome = await recovered.service.wait(parent, edge.childId, new AbortController().signal);
  expect(outcome.outcome).toBe("failed");
  expect(recovered.contexts.has(edge.childId)).toBe(false);
  expect(wakes(recovered.events, parent.threadId)).toHaveLength(1);
});
