import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { createWriteStream } from "node:fs";
import { mkdir, appendFile } from "node:fs/promises";
import { once } from "node:events";
import {
  environment,
  jsonl,
  claudeRecords,
  cwd,
  nativeId,
  otherId,
  init,
  memorySink,
} from "./test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
test("cancelled incremental scans retain earlier entries until a complete scan prunes", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "home");
  for (let i = 0; i < 130; i++)
    await jsonl(
      join(home, "projects/p", String(i) + ".jsonl"),
      claudeRecords("session " + i, String(i)),
    );
  const service = await env.start([{ id: "home", provider: "claude", homeDir: home }]);
  await service.scan();
  const controller = new AbortController();
  await expect(service.scan(controller.signal, () => controller.abort())).rejects.toThrow();
  let total = 0;
  let page = await service.list({ type: "history.list", cwd, limit: 50 });
  for (;;) {
    total += page.sessions.length;
    if (!page.next) break;
    page = await service.list({ type: "history.list", cwd, limit: 50, before: page.next });
  }
  expect(total).toBe(130);
  expect((await service.scan()).reads).toBe(0);
});
test("head and tail sampling stays bounded and a full import upgrades the count", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "home"),
    dir = join(home, "projects/p");
  await mkdir(dir, { recursive: true });
  const path = join(dir, nativeId + ".jsonl");
  const stream = createWriteStream(path);
  const count = 6000;
  for (let i = 0; i < count; i++) {
    const line =
      JSON.stringify({
        type: "user",
        sessionId: nativeId,
        cwd,
        message: { role: "user", content: "message " + i + "x".repeat(500) },
      }) + "\n";
    if (!stream.write(line)) await once(stream, "drain");
  }
  stream.end();
  await once(stream, "finish");
  const service = await env.start([{ id: "home", provider: "claude", homeDir: home }]);
  const scan = await service.scan();
  expect(scan.bytes).toBeLessThanOrEqual(128 * 1024);
  const s = (await service.list({ type: "history.list", cwd })).sessions[0];
  if (!s) throw new Error("missing");
  expect(s.countAccuracy).toBe("sampled");
  expect(s.messageCount).toBeLessThan(count);
  let emitted = 0;
  let largest = 0;
  const sink = memorySink();
  await service.importSession(init(s.id), {
    ...sink,
    appendItem: async (item) => {
      emitted++;
      largest = Math.max(largest, Buffer.byteLength(JSON.stringify(item)));
    },
  });
  expect(emitted).toBe(count);
  expect(largest).toBeLessThan(4096);
  expect(await service.get(s.id)).toMatchObject({ messageCount: count, countAccuracy: "exact" });
}, 15000);
test("import waits for each sink write before reading the next item", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "home");
  await jsonl(join(home, "projects/p", nativeId + ".jsonl"), claudeRecords());
  const service = await env.start([{ id: "home", provider: "claude", homeDir: home }]);
  await service.scan();
  const s = (await service.list({ type: "history.list", cwd })).sessions[0];
  if (!s) throw new Error("missing");
  let release: () => void = noop;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = noop;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let writes = 0;
  const sink = memorySink();
  const importing = service.importSession(init(s.id), {
    ...sink,
    appendItem: async (item) => {
      writes++;
      if (writes === 1) {
        started();
        await gate;
      }
      await sink.appendItem(item);
    },
  });
  await entered;
  await expect(service.list({ type: "history.list", cwd })).rejects.toThrow("Import in progress");
  expect(writes).toBe(1);
  expect(sink.committed).toBe(false);
  release();
  await importing;
  expect(writes).toBe(2);
  expect(sink.committed).toBe(true);
});
test("item cursors return the full transcript exactly once in bounded windows", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "home"),
    path = join(home, "projects/p", nativeId + ".jsonl");
  await jsonl(path, claudeRecords());
  for (let i = 0; i < 250; i++)
    await appendFile(
      path,
      JSON.stringify({
        type: "user",
        sessionId: nativeId,
        cwd,
        message: { role: "user", content: "page " + i },
      }) + "\n",
    );
  const service = await env.start([{ id: "home", provider: "claude", homeDir: home }]);
  await service.scan();
  const s = (await service.list({ type: "history.list", cwd })).sessions[0];
  if (!s) throw new Error("missing");
  await service.importSession(init(s.id));
  const ids = new Set<string>();
  let after = 0;
  for (;;) {
    const page = await service.itemsPage({ threadId: init(s.id).threadId, after, limit: 13 });
    expect(page.items.length).toBeLessThanOrEqual(13);
    for (const item of page.items) {
      expect(ids.has(item.id)).toBe(false);
      ids.add(item.id);
    }
    if (page.next === null) break;
    after = page.next;
  }
  expect(ids.size).toBe(252);
});
test("fork lineage is not imported as a child agent", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "codex");
  await jsonl(join(home, "sessions/2026/01/01/root.jsonl"), [
    { type: "session_meta", payload: { id: nativeId, cwd } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Review root" }],
      },
    },
  ]);
  await jsonl(join(home, "sessions/2026/01/01/fork.jsonl"), [
    { type: "session_meta", payload: { id: otherId, cwd, forked_from_id: nativeId } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Review fork" }],
      },
    },
  ]);
  const service = await env.start([{ id: "cx", provider: "codex", homeDir: home }]);
  await service.scan();
  const s = (await service.list({ type: "history.list", cwd })).sessions.find(
    (r) => r.nativeId === nativeId,
  );
  if (!s) throw new Error("missing");
  await service.importSession(init(s.id));
  expect(await service.importedAgents(init(s.id).threadId)).toHaveLength(1);
});

function noop(): void {}

test("concurrent operations reject instead of accumulating an unbounded worker queue", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "home");
  await jsonl(join(home, "projects/p", nativeId + ".jsonl"), claudeRecords());
  const service = await env.start([{ id: "home", provider: "claude", homeDir: home }]);
  const scanning = service.scan();
  await expect(service.scan()).rejects.toThrow("already in progress");
  await scanning;
});
test("historical tools with no completion retain unresolved status", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "home");
  await jsonl(join(home, "projects/p", nativeId + ".jsonl"), [
    { type: "user", sessionId: nativeId, cwd, message: { role: "user", content: "Run the build" } },
    {
      type: "assistant",
      sessionId: nativeId,
      cwd,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Bash", id: "call", input: { command: "long build" } }],
      },
    },
  ]);
  const service = await env.start([{ id: "home", provider: "claude", homeDir: home }]);
  await service.scan();
  const s = (await service.list({ type: "history.list", cwd })).sessions[0];
  if (!s) throw new Error("missing");
  await service.importSession(init(s.id));
  const items = (await service.itemsPage({ threadId: init(s.id).threadId })).items;
  expect(items.find((i) => i.type === "tool_call")).toMatchObject({
    call: { kind: "shell", status: "pending", detail: { kind: "shell", command: "long build" } },
  });
});

test("cancelling a default worker import leaves no published thread", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "home");
  await jsonl(join(home, "projects/p", nativeId + ".jsonl"), claudeRecords());
  const service = await env.start([{ id: "home", provider: "claude", homeDir: home }]);
  await service.scan();
  const s = (await service.list({ type: "history.list", cwd })).sessions[0];
  if (!s) throw new Error("missing");
  const controller = new AbortController();
  const importing = service.importSession(init(s.id), undefined, controller.signal);
  controller.abort();
  await expect(importing).rejects.toThrow();
  expect(await service.importedThread(init(s.id).threadId)).toBeNull();
  await service.importSession(init(s.id));
});

test("large tool inputs remain lossless blobs while their display items fit a page", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "home"),
    path = join(home, "projects/p", nativeId + ".jsonl");
  await jsonl(path, [
    ...claudeRecords(),
    {
      type: "assistant",
      sessionId: nativeId,
      cwd,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: "x".repeat(900000) } }],
      },
    },
  ]);
  const service = await env.start([{ id: "home", provider: "claude", homeDir: home }]);
  await service.scan();
  const s = (await service.list({ type: "history.list", cwd })).sessions[0];
  if (!s) throw new Error("missing");
  await service.importSession(init(s.id));
  const page = await service.itemsPage({ threadId: init(s.id).threadId });
  expect(page.items.length).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(10000);
  const tool = page.items.find((i) => i.type === "tool_call");
  if (!tool || tool.type !== "tool_call") throw new Error("missing tool");
  expect(tool.call.detail).toMatchObject({ kind: "shell", command: "x".repeat(4096) });
  const raw = tool.call.raw[0];
  const id = String((await import("@ace/native-session")).object(raw).blobRef);
  expect((await service.readBlob({ id, offset: 0, limit: 256 * 1024 })).size).toBeGreaterThan(
    900000,
  );
});

test.skipIf(process.platform === "win32")(
  "a transcript replaced by a FIFO after staging is refused without waiting for a writer",
  async () => {
    const { spawnSync } = await import("node:child_process");
    const { unlink } = await import("node:fs/promises");
    const env = await environment();
    cleanup.push(env.close);
    const home = join(env.root, "home"),
      path = join(home, "projects/p", nativeId + ".jsonl");
    await jsonl(path, claudeRecords());
    const service = await env.start([{ id: "home", provider: "claude", homeDir: home }]);
    await service.scan();
    const s = (await service.list({ type: "history.list", cwd })).sessions[0];
    if (!s) throw new Error("missing");
    const sink = service.archiveSink();
    await expect(
      service.importSession(init(s.id), {
        ...sink,
        begin: async (thread) => {
          await sink.begin(thread);
          await unlink(path);
          const result = spawnSync("mkfifo", [path]);
          if (result.status !== 0) throw new Error("Could not create FIFO");
        },
      }),
    ).rejects.toThrow("regular file");
    expect(await service.importedThread(init(s.id).threadId)).toBeNull();
  },
);
