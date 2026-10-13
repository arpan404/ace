import { join } from "node:path";
import { backup, type DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { setup } from "./test-support.ts";

test("a delegated child names its parent on its own thread, and still does after a restart", async () => {
  const h = setup();
  const parent = await h.parent();
  const edge = h.delegate(parent, "names-parent");
  await h.engine.flush();
  expect(h.store.getThread(edge.childId)?.delegatedBy).toBe(parent.threadId);
  // A thread the person started names no parent.
  expect(h.store.getThread(parent.threadId)?.delegatedBy).toBeUndefined();

  const snapshot = join(h.home, "delegated-by.sqlite");
  let source: DatabaseSync | undefined;
  h.store.atomic((db) => {
    source = db;
  });
  if (!source) throw new Error("Missing snapshot source");
  await backup(source, snapshot);
  await h.close();
  const reopened = setup({}, snapshot);
  expect(reopened.store.getThread(edge.childId)?.delegatedBy).toBe(parent.threadId);
});
