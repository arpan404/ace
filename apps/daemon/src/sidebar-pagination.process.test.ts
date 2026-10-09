import { afterEach, expect, test } from "vitest";
import { Thread, type ServerMessage } from "@ace/protocol";
import { sidebarPage } from "@ace/projection";
import { fixture } from "./socket-test-support.ts";
import { subscribe, pageSubscription } from "./subscription.ts";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function seeded() {
  const f = await fixture();
  cleanup.push(() => f.close());
  const workspace = f.thread.workspaceId;
  const entries = Array.from({ length: 55 }, (_, i) =>
    Thread.parse({
      id: `history-${String(i).padStart(3, "0")}`,
      workspaceId: workspace,
      title: `Task ${i}`,
      provider: "codex",
      status: { state: "done" },
      createdAt: 1,
      updatedAt: 1000 - i,
      activityAt: 1000 - i,
      settledAt: 2000,
      hasSentMessage: true,
    }),
  );
  for (const entry of entries)
    f.store.appendEvents(entry.id, [{ type: "thread.created", thread: entry }], entry.updatedAt);
  const active = Thread.parse({
    ...entries[0],
    id: "active",
    status: { state: "working", agents: 1 },
  });
  f.store.appendEvents(active.id, [{ type: "thread.created", thread: active }], 3000);
  const pinned = Thread.parse({ ...entries[0], id: "pinned", pinned: true });
  f.store.appendEvents(pinned.id, [{ type: "thread.created", thread: pinned }], 3000);
  return { ...f, entries, active, pinned };
}
test("initial actual payload contains all unsettled/pinned and only 20 settled, subsequent pages fetch 20", async () => {
  const f = await seeded();
  const messages: ServerMessage[] = [];
  const stop = subscribe(
    f.store,
    "bounded",
    { kind: "threads", window: { limit: 20 } },
    undefined,
    5000,
    (message) => messages.push(message),
  );
  try {
    const snapshot = messages[0];
    expect(snapshot?.type).toBe("snapshot");
    if (snapshot?.type !== "snapshot" || snapshot.view.kind !== "threads")
      throw new Error("Missing snapshot");
    expect(Object.keys(snapshot.view.threads)).toHaveLength(23);
    expect(snapshot.view.threads.active).toBeDefined();
    expect(snapshot.view.threads.pinned).toBeDefined();
    expect(snapshot.view.window?.total).toBe(55);
    expect(snapshot.view.window?.counts[0]?.threads).toBe(57);
    const before = snapshot.view.window?.before;
    if (!before) throw new Error("Missing cursor");
    pageSubscription(stop, before, "next");
    const page = messages.at(-1);
    if (page?.type !== "threads.patch") throw new Error("Missing page");
    expect(Object.keys(page.threads)).toHaveLength(20);
    const initialThreads = snapshot.view.threads;
    expect(Object.keys(page.threads).some((id) => Object.hasOwn(initialThreads, id))).toBe(false);
    expect(page.requestId).toBe("next");
    expect(page.window.before).not.toBeNull();
    if (!page.window.before) throw new Error("Missing last page cursor");
    pageSubscription(stop, page.window.before, "last");
    const last = messages.at(-1);
    if (last?.type !== "threads.patch") throw new Error("Missing last page");
    expect(Object.keys(last.threads)).toHaveLength(15);
    expect(last.window.before).toBeNull();
  } finally {
    stop();
  }
});
test("unseen old settled threads enter live on unsettle and archive removes them without downloading history", async () => {
  const f = await seeded();
  const messages: ServerMessage[] = [];
  const stop = subscribe(
    f.store,
    "live",
    { kind: "threads", window: { limit: 20 } },
    undefined,
    5000,
    (message) => messages.push(message),
  );
  try {
    const id = f.entries[54]!.id;
    f.store.appendEvents(
      id,
      [{ type: "thread.client.updated", changes: { settledAt: null } }],
      5000,
    );
    const change = messages.at(-1);
    if (change?.type !== "threads.patch") throw new Error("Missing change");
    expect(change.threads[id]?.settledAt).toBeUndefined();
    expect(change.window.total).toBe(54);
    f.store.appendEvents(id, [{ type: "thread.updated", archivedAt: 5001 }], 5001);
    const archived = messages.at(-1);
    if (archived?.type !== "threads.patch") throw new Error("Missing archive");
    expect(archived.removed).toContain(id);
    expect(archived.window.counts[0]?.threads).toBe(56);
  } finally {
    stop();
  }
});
test("SQL classification and ordering match shared pagination for filters, pins, drafts and queue attention", async () => {
  const f = await seeded();
  const id = f.entries[53]!.id;
  const original = f.store.getThread(id)!;
  f.store.appendEvents(
    id,
    [
      {
        type: "queue.updated",
        revision: 1,
        pendingCount: 1,
        paused: true,
        reason: "manual",
        resumeAt: null,
      },
    ],
    5000,
  );
  expect(f.store.getThread(id)?.queue).toBeDefined();
  for (const options of [
    { limit: 20 },
    { limit: 20, project: original.workspaceId },
    { limit: 20, project: "missing" },
    { limit: 20, archived: true },
  ]) {
    const expected = sidebarPage(f.store.listThreads(), options);
    const actual = f.store.sidebarPage(options);
    expect(actual.threads.map((entry) => entry.id)).toEqual(
      expected.threads.map((entry) => entry.id),
    );
    expect(actual.window).toEqual(expected.window);
  }
});

test("settling active work prunes the older edge of the loaded window and stable cursors do not repeat ties", async () => {
  const f = await seeded();
  const messages: ServerMessage[] = [];
  const stop = subscribe(
    f.store,
    "prune",
    { kind: "threads", window: { limit: 20 } },
    undefined,
    5000,
    (message) => messages.push(message),
  );
  try {
    f.store.appendEvents(
      f.active.id,
      [
        { type: "thread.updated", status: { state: "done" } },
        { type: "thread.client.updated", changes: { settledAt: 6000, activityAt: 6000 } },
      ],
      6000,
    );
    const update = messages.at(-1);
    if (update?.type !== "threads.patch") throw new Error("Missing live patch");
    expect(update.threads.active?.settledAt).toBe(6000);
    expect(update.removed).toContain(f.entries[19]!.id);
    expect(update.window.total).toBe(56);
    const before = update.window.before;
    if (!before) throw new Error("Missing page cursor");
    pageSubscription(stop, before, "stable");
    const page = messages.at(-1);
    if (page?.type !== "threads.patch") throw new Error("Missing page");
    expect(Object.keys(page.threads)).toHaveLength(20);
    expect(Object.keys(page.threads)).toContain(f.entries[19]!.id);
  } finally {
    stop();
  }
});
