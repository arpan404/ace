import { access, readFile, writeFile, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { storageFixture } from "./test-support.ts";

const fixtures: Awaited<ReturnType<typeof storageFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function setup() {
  const fixture = await storageFixture();
  fixtures.push(fixture);
  return fixture;
}

test("a preview reports exact old files and keeps the current log until apply", async () => {
  const f = await setup();
  const old = await f.file("logs/ace.1.jsonl", "rotated");
  const current = await f.file("logs/ace.jsonl", "current");
  const plan = await f.storage.plan("owner", {
    op: "cleanup.plan",
    kinds: ["logs"],
    forceItems: [],
  });
  expect(plan.items.find((item) => item.label === "logs/ace.1.jsonl")).toMatchObject({
    disposition: "remove",
    bytes: 7,
    reasons: ["expired"],
  });
  expect(plan.items.find((item) => item.label === "logs/ace.jsonl")).toMatchObject({
    disposition: "protect",
    reasons: ["leased"],
  });
  expect(await readFile(old, "utf8")).toBe("rotated");
  expect((await f.storage.apply("owner", plan.id, plan.revision)).state).toBe("complete");
  await expect(access(old)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(current, "utf8")).toBe("current");
});

test("a changed file invalidates the entire reviewed plan before another file can be deleted", async () => {
  const f = await setup();
  const first = await f.file("logs/ace.1.jsonl");
  const second = await f.file("logs/ace.2.jsonl");
  const plan = await f.storage.plan("owner");
  await writeFile(second, "new data");
  expect((await f.storage.apply("owner", plan.id, plan.revision)).state).toBe("stale");
  expect(await readFile(first, "utf8")).toBe("old data");
  expect(await readFile(second, "utf8")).toBe("new data");
});

test("pinned and human-waiting descendants protect their whole archived tree", async () => {
  const f = await setup();
  const root = f.thread("root");
  const child = f.thread("child", { state: "needs_you", interactions: 1 });
  f.store.atomic((db) => {
    db.exec(
      "CREATE TABLE delegation_participants(thread_id TEXT PRIMARY KEY,root_id TEXT); CREATE TABLE delegation_trees(root_id TEXT PRIMARY KEY,active INTEGER)",
    );
    db.prepare("INSERT INTO delegation_participants VALUES (?,?)").run(root.id, root.id);
    db.prepare("INSERT INTO delegation_participants VALUES (?,?)").run(child.id, root.id);
  });
  const plan = await f.storage.plan("owner");
  expect(plan.items.filter((item) => item.kind === "threads")).toHaveLength(2);
  expect(
    plan.items
      .filter((item) => item.kind === "threads")
      .every((item) => item.disposition === "protect" && item.reasons.includes("active_tree")),
  ).toBe(true);
  f.store.appendEvents(
    child.id,
    [
      { type: "thread.updated", status: { state: "done" } },
      { type: "thread.client.updated", changes: { pinned: true } },
    ],
    2,
  );
  expect(
    (await f.storage.plan("owner")).items
      .filter((item) => item.kind === "threads")
      .every((item) => item.reasons.includes("pinned")),
  ).toBe(true);
});

test("paused and uncertain sends survive retention even when the stored thread says done", async () => {
  const f = await setup();
  const thread = f.thread("held");
  f.store.atomic((db) => {
    db.exec(
      "CREATE TABLE intents(thread_id TEXT,status TEXT,awaiting INTEGER,uncertain INTEGER); CREATE TABLE engine_queue(thread_id TEXT,continuation TEXT,resume_at INTEGER)",
    );
    db.prepare("INSERT INTO intents VALUES (?,'queued',0,0)").run(thread.id);
  });
  expect(
    (await f.storage.plan("owner")).items.find((item) => item.kind === "threads")?.reasons,
  ).toContain("pending_input");
});

test("purging an archived transcript keeps its tombstone and another thread's attachment", async () => {
  const f = await setup();
  const old = f.thread("old");
  const shared = f.thread("shared");
  await f.upload(old.id);
  const hash = await f.upload(shared.id);
  const plan = await f.storage.plan("owner", {
    op: "cleanup.plan",
    kinds: ["threads"],
    forceItems: [],
  });
  const oldItem = plan.items.find((item) => item.label === "old");
  expect(oldItem?.disposition).toBe("remove");
  // Keep the second owner independently retained before reviewing a fresh plan.
  f.store.appendEvents(
    shared.id,
    [{ type: "thread.client.updated", changes: { pinned: true } }],
    2,
  );
  const reviewed = await f.storage.plan("owner", {
    op: "cleanup.plan",
    kinds: ["threads"],
    forceItems: [],
  });
  expect((await f.storage.apply("owner", reviewed.id, reviewed.revision)).state).toBe("complete");
  expect(f.store.getThread(old.id)?.deletedAt).toBeDefined();
  expect(f.store.readEvents({ afterSeq: 0, threadId: old.id, limit: 100 })).toEqual([]);
  const attachment = await f.services.context?.uploads.acquire("owner", shared.id, [hash]);
  expect(await readFile(attachment?.blobs[0]?.path ?? "", "utf8")).toBe("attachment body");
  attachment?.release();
});

test("a replacement directory cannot redirect cleanup outside the pinned daemon root", async () => {
  const f = await setup();
  await f.file("logs/ace.1.jsonl");
  const outside = await f.file("outside/ace.1.jsonl", "keep me");
  const plan = await f.storage.plan("owner");
  await rename(join(f.root, "logs"), join(f.root, "old-logs"));
  await symlink(join(f.root, "outside"), join(f.root, "logs"));
  await expect(f.storage.apply("owner", plan.id, plan.revision)).rejects.toBeDefined();
  expect(await readFile(outside, "utf8")).toBe("keep me");
});

test("plans belong to their reviewer and expire before deletion", async () => {
  const f = await setup();
  const path = await f.file("logs/ace.1.jsonl");
  const plan = await f.storage.plan("owner");
  await expect(f.storage.apply("other-device", plan.id, plan.revision)).rejects.toThrow(
    "storage_plan_not_found",
  );
  f.advance(900001);
  expect((await f.storage.apply("owner", plan.id, plan.revision)).state).toBe("stale");
  expect(await readFile(path, "utf8")).toBe("old data");
});

test("the scheduled hook uses the ordinary protected plan and never forces a retained file", async () => {
  const f = await setup();
  const old = await f.file("logs/ace.1.jsonl");
  const current = await f.file("logs/ace.jsonl", "keep current");
  const result = await f.storage.scheduledCleanup();
  expect(result.state).toBe("complete");
  await expect(access(old)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(current, "utf8")).toBe("keep current");
});

test("cleanup removes reviewed bytes and leaves durable writes available", async () => {
  const f = await setup();
  const path = await f.file("logs/ace.1.jsonl");
  const thread = f.thread("retained");
  const plan = await f.storage.plan("owner", {
    op: "cleanup.plan",
    kinds: ["logs"],
    forceItems: [],
  });
  const result = await f.storage.handle(
    "owner",
    {
      type: "storage.request",
      requestId: "cleanup-writes",
      operation: { op: "cleanup.apply", planId: plan.id, revision: plan.revision },
    },
    () => true,
  );
  expect(result.result).toMatchObject({
    kind: "apply",
    apply: {
      state: "complete",
      items: [{ state: "removed" }],
    },
  });
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  f.store.appendEvents(thread.id, [{ type: "thread.updated", title: "Still writable" }], 2);
  expect(f.store.getThread(thread.id)?.title).toBe("Still writable");
  expect(await f.storage.apply("owner", plan.id, plan.revision)).toEqual(
    f.storage.status("owner", plan.id),
  );
});
