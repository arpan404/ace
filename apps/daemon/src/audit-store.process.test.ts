/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker boundary. */
import { expect, test } from "vitest";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { createDevThread } from "./commands.ts";
import { message } from "./payload-test-support.ts";

test("snapshots include title, queue and deletion changes after item events in a committed batch", async () => {
  const store = new Store(":memory:");
  try {
    const thread = createDevThread(store, store.createWorkspace("/repo", "Repo"));
    store.acquireThread(thread.id);
    store.appendEvents(thread.id, [
      { type: "item.created", item: message("answer") },
      { type: "thread.updated", title: "Updated", status: { state: "done" } },
      {
        type: "queue.updated",
        revision: 7,
        paused: true,
        reason: "manual",
        resumeAt: null,
        pendingCount: 3,
      },
      { type: "thread.client.updated", changes: { deletedAt: 123 } },
    ]);
    const snapshot = store.acquireThread(thread.id);
    expect(snapshot.thread).toMatchObject({
      title: "Updated",
      status: { state: "done" },
      deletedAt: 123,
    });
    expect(snapshot.queue).toMatchObject({ revision: 7, paused: true, pendingCount: 3 });
    expect(snapshot.seq).toBe(store.headSeq());
  } finally {
    await store.close();
  }
});

test("a damaged cached view cannot turn a committed append into an error or hide its publication", async () => {
  const errors: unknown[] = [];
  const store = new Store(":memory:", (error) => errors.push(error));
  try {
    const thread = createDevThread(store, store.createWorkspace("/repo", "Repo"));
    Object.freeze(store.acquireThread(thread.id).thread);
    const titles: string[] = [];
    store.subscribe((events) => {
      for (const event of events)
        if (event.payload.type === "thread.updated" && event.payload.title)
          titles.push(event.payload.title);
    });
    expect(() =>
      store.appendEvents(thread.id, [{ type: "thread.updated", title: "Committed" }]),
    ).not.toThrow();
    expect(titles).toEqual(["Committed"]);
    expect(store.acquireThread(thread.id).thread.title).toBe("Committed");
    expect(errors).toHaveLength(1);
  } finally {
    await store.close();
  }
});

test("history batches reach subscribers before higher live sequences including reentrant writes", async () => {
  const store = new Store(":memory:");
  try {
    const thread = createDevThread(store, store.createWorkspace("/repo", "Repo"));
    const after = store.headSeq();
    const observed: number[] = [];
    let appended = false;
    store.subscribe((events) => {
      observed.push(...events.map((event) => event.seq));
      if (!appended) {
        appended = true;
        store.appendEvents(thread.id, [{ type: "thread.updated", title: "Live" }]);
      }
    });
    store.setHistoryWriting(true);
    for (let i = 0; i < 40; i++)
      store.appendEvents(thread.id, [{ type: "thread.updated", title: `Imported ${i}` }]);
    await store.notifyHistory(after);
    store.setHistoryWriting(false);
    expect(observed).toEqual(Array.from({ length: 41 }, (_, i) => after + i + 1));
    expect(store.acquireThread(thread.id).thread.title).toBe("Live");
  } finally {
    store.setHistoryWriting(false);
    await store.close();
  }
});

test("metadata writes wait for a real worker transaction instead of failing immediately during publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-audit-writer-"));
  const path = join(root, "events.sqlite");
  const store = new Store(path);
  const entry = join(root, "writer.mjs");
  await writeFile(
    entry,
    `import { DatabaseSync } from 'node:sqlite'; import { parentPort, workerData } from 'node:worker_threads';
    const db = new DatabaseSync(workerData.path); db.exec('BEGIN IMMEDIATE'); parentPort.postMessage('locked');
    parentPort.once('message', () => { db.exec('COMMIT'); db.close(); parentPort.close(); });`,
  );
  const worker = new Worker(entry, { workerData: { path } });
  const exited = once(worker, "exit");
  try {
    await once(worker, "message");
    store.setHistoryWriting(true);
    worker.postMessage("release");
    const workspace = store.createWorkspace("/new", "Added during import");
    expect(store.getWorkspace(workspace)?.name).toBe("Added during import");
    await exited;
  } finally {
    store.setHistoryWriting(false);
    await worker.terminate();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("history notification reclaims a WAL retained by an earlier reader", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-audit-wal-"));
  const path = join(root, "events.sqlite");
  const store = new Store(path);
  const reader = new DatabaseSync(path);
  try {
    const thread = createDevThread(store, store.createWorkspace("/repo", "Repo"));
    const after = store.headSeq();
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) FROM events").get();
    store.setHistoryWriting(true);
    for (let i = 0; i < 64; i++)
      store.appendEvents(thread.id, [
        { type: "item.created", item: message(`import-${i}`, "x".repeat(64 * 1024)) },
      ]);
    expect((await stat(path + "-wal")).size).toBeGreaterThan(1024 * 1024);
    reader.exec("COMMIT");
    await store.notifyHistory(after);
    store.setHistoryWriting(false);
    expect((await stat(path + "-wal")).size).toBe(0);
    expect(store.readEvents({ afterSeq: after, limit: 100 })).toHaveLength(64);
  } finally {
    reader.close();
    store.setHistoryWriting(false);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
