import { DatabaseSync } from "node:sqlite";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { environment, jsonl, cwd } from "./test-support.ts";

const records = (id: string, seconds: number) => [
  {
    type: "user",
    sessionId: id,
    cwd,
    timestamp: new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString(),
    message: { role: "user", content: id },
  },
];

// The progress callback is the worker's backpressure boundary, not a timing delay.
test("pagination and saved recency remain consistent when tree indexing is cancelled between batches", async () => {
  const env = await environment();
  const home = join(env.root, "claude");
  const root = join(home, "projects/p/root.jsonl");
  const middle = join(home, "projects/p/middle.jsonl");
  const child = join(home, "projects/p/root/subagents/child.jsonl");
  for (const [path, id, seconds] of [
    [root, "root", 10],
    [middle, "middle", 50],
    [child, "child", 100],
  ] as const) {
    await jsonl(path, records(id, seconds));
    await utimes(path, 0, 0);
  }
  const service = await env.start([{ id: "account", provider: "claude", homeDir: home }]);
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const controller = new AbortController();
  const activity = Date.UTC(2026, 0, 1) + 100_000;
  const scanning = service.scan(controller.signal, async () => {
    const page = await service.list({ type: "history.list", cwd, limit: 1 });
    if (page.sessions[0]?.nativeId === "root" && page.sessions[0].lastActivity === activity) {
      reached.resolve();
      await gate.promise;
    }
  });
  // Attach rejection handling before aborting the real worker.
  const cancelled = expect(scanning).rejects.toThrow();
  try {
    await reached.promise;
    const first = await service.list({ type: "history.list", cwd, limit: 1 });
    expect(first.sessions.map((s) => s.nativeId)).toEqual(["root"]);
    expect(first.next?.lastActivity).toBe(activity);
    if (!first.next) throw new Error("Missing history cursor");
    const second = await service.list({ type: "history.list", cwd, limit: 1, before: first.next });
    expect(second.sessions.map((s) => s.nativeId)).toEqual(["middle"]);
    controller.abort();
    await cancelled;
    const saved = await service.list({ type: "history.list", cwd, limit: 1 });
    expect(saved.next).toEqual(first.next);
    const id = saved.sessions[0]?.id;
    if (!id) throw new Error("Missing saved root");
    expect((await service.get(id))?.lastActivity).toBe(activity);
    const after = await service.list({ type: "history.list", cwd, limit: 1, before: first.next });
    expect(after.sessions.map((s) => s.nativeId)).toEqual(["middle"]);
  } finally {
    controller.abort();
    gate.resolve();
    await scanning.catch(() => {});
    await env.close();
  }
}, 10_000);

test("a persisted index from interrupted older aggregation paginates by committed ordering columns", async () => {
  const env = await environment();
  try {
    const home = join(env.root, "claude");
    for (const [id, seconds] of [
      ["root", 100],
      ["middle", 50],
    ] as const) {
      const path = join(home, "projects/p", id + ".jsonl");
      await jsonl(path, records(id, seconds));
      await utimes(path, 0, 0);
    }
    const homes = [{ id: "account", provider: "claude" as const, homeDir: home }];
    const service = await env.start(homes);
    await service.scan();
    await service.close();
    // Model an on-disk fact left by the old daemon, then read through the public API.
    const database = new DatabaseSync(join(env.root, "ace/index.sqlite"));
    try {
      database.exec(
        "UPDATE sources SET summary=json_set(summary,'$.lastActivity',10) WHERE native='root'",
      );
    } finally {
      database.close();
    }
    const reopened = await env.start(homes);
    const first = await reopened.list({ type: "history.list", cwd, limit: 1 });
    expect(first.sessions[0]?.lastActivity).toBe(Date.UTC(2026, 0, 1) + 100_000);
    if (!first.next) throw new Error("Missing persisted cursor");
    const second = await reopened.list({ type: "history.list", cwd, limit: 1, before: first.next });
    expect(second.sessions.map((session) => session.nativeId)).toEqual(["middle"]);
  } finally {
    await env.close();
  }
}, 10_000);
