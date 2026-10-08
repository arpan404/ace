import { afterEach, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  environment,
  jsonl,
  claudeRecords,
  codexRecords,
  nativeId,
  cwd,
  init,
  memorySink,
  text,
} from "./test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function setup(provider: "claude" | "codex" = "claude") {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, provider);
  const path = join(
    home,
    provider === "claude" ? `projects/p/${nativeId}.jsonl` : "sessions/2026/01/01/rollout.jsonl",
  );
  await jsonl(path, provider === "claude" ? claudeRecords() : codexRecords());
  const homes = [{ id: "account", provider, homeDir: home }];
  const service = await env.start(homes);
  await service.scan();
  const source = (await service.list({ type: "history.list", cwd })).sessions[0];
  if (!source) throw new Error("Missing source");
  return { ...env, home, homes, path, source, service };
}
test("database metadata remains listed after its duplicate rollout is deleted on warm scans", async () => {
  const { home, path, service } = await setup("codex");
  const db = new DatabaseSync(join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads(id TEXT,cwd TEXT,title TEXT,updated_at INTEGER)");
  db.prepare("INSERT INTO threads VALUES(?,?,?,?)").run(nativeId, cwd, "database fallback", 10);
  db.close();
  await service.scan();
  expect((await service.list({ type: "history.list", cwd })).sessions).toHaveLength(1);
  await unlink(path);
  for (let i = 0; i < 2; i++) {
    await service.scan();
    expect((await service.list({ type: "history.list", cwd })).sessions).toMatchObject([
      {
        nativeId,
        title: "database fallback",
        countAccuracy: "sampled",
        support: { status: "unsupported" },
      },
    ]);
  }
});
test("unknown Claude event IDs cannot replace the native resume identity", async () => {
  const { service, path } = await setup();
  await appendFile(
    path,
    JSON.stringify({ type: "future-record", id: "unrelated-event-id" }) + "\n",
  );
  await service.scan();
  const s = (await service.list({ type: "history.list", cwd })).sessions[0];
  expect(s?.nativeId).toBe(nativeId);
  if (!s) throw new Error("Missing source");
  expect(await service.continuation(s.id, "resume")).toMatchObject({
    resume: { nativeSessionId: nativeId },
  });
});
test("removed accounts are inaccessible immediately after reopening and after scanning", async () => {
  const { service, source, start } = await setup();
  await service.close();
  const removed = await start([]);
  for (let i = 0; i < 2; i++) {
    expect((await removed.list({ type: "history.list", cwd })).sessions).toEqual([]);
    expect(await removed.get(source.id)).toBeNull();
    await expect(removed.continuation(source.id, "resume")).rejects.toThrow();
    await removed.scan();
  }
});
test("huge native metadata is lossless in blobs and item cursors always advance", async () => {
  const { service, source, path } = await setup();
  await appendFile(path, JSON.stringify({ type: "t".repeat(1_048_000), novel: true }) + "\n");
  await service.scan();
  await service.importSession(init(source.id));
  let after = 0;
  for (;;) {
    const page = await service.itemsPage({ threadId: init(source.id).threadId, after, limit: 1 });
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items)
      expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThan(128 * 1024);
    if (page.next === null) break;
    expect(page.next).toBeGreaterThan(after);
    after = page.next;
  }
});
test("Claude imports only the selected parentUuid conversation branch", async () => {
  const { service, source, path } = await setup();
  const base = { sessionId: nativeId, cwd };
  await jsonl(path, [
    {
      ...base,
      type: "user",
      uuid: "u",
      parentUuid: null,
      message: { role: "user", content: "question" },
    },
    {
      ...base,
      type: "assistant",
      uuid: "old",
      parentUuid: "u",
      message: { role: "assistant", content: "abandoned answer" },
    },
    {
      ...base,
      type: "assistant",
      uuid: "new",
      parentUuid: "u",
      message: { role: "assistant", content: "replacement answer" },
    },
    {
      ...base,
      type: "user",
      uuid: "next",
      parentUuid: "new",
      message: { role: "user", content: "follow-up" },
    },
  ]);
  await service.scan();
  await service.importSession(init(source.id));
  const items = (await service.itemsPage({ threadId: init(source.id).threadId })).items;
  expect(text(items)).toBe("question replacement answer follow-up");
  expect((await service.get(source.id))?.messageCount).toBe(3);
});
for (const provider of ["claude", "codex"] as const)
  test(`${provider} native results complete their call and link all output`, async () => {
    const { service, source, path } = await setup(provider);
    if (provider === "claude") {
      await jsonl(path, [
        ...claudeRecords(),
        {
          type: "assistant",
          sessionId: nativeId,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "tool1", name: "Bash", input: { command: "pwd" } }],
          },
        },
        {
          type: "user",
          sessionId: nativeId,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool1", content: "linked output" }],
          },
        },
      ]);
      await service.scan();
    }
    await service.importSession(init(source.id));
    const items = (await service.itemsPage({ threadId: init(source.id).threadId })).items;
    const tool = items.find((i) => i.type === "tool_call");
    expect(tool?.type === "tool_call" && tool.call.status).toBe("succeeded");
    if (tool?.type !== "tool_call" || tool.call.detail.kind !== "shell")
      throw new Error("Missing shell");
    expect(tool.call.detail.output).toMatchObject({
      tail: provider === "claude" ? "linked output" : cwd,
      bytes: Buffer.byteLength(provider === "claude" ? "linked output" : cwd),
    });
    expect(tool.call.raw.length).toBeGreaterThanOrEqual(2);
    expect(
      items.some(
        (i) =>
          i.type === "notice" &&
          i.toolCallId === tool.id &&
          i.text === (provider === "claude" ? "linked output" : cwd),
      ),
    ).toBe(true);
    const blob = await service.readBlob({
      id: tool.call.detail.output?.streamId ?? "",
      offset: 0,
      limit: 256,
    });
    expect(Buffer.from(blob.bytes).toString()).toBe(provider === "claude" ? "linked output" : cwd);
  });
test("closing a paused SQLite import removes every private transcript copy", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "oc");
  await mkdir(home);
  const db = new DatabaseSync(join(home, "opencode.db"));
  db.exec(
    "CREATE TABLE session(id TEXT,directory TEXT,title TEXT,time_updated INTEGER,parent_id TEXT);CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);CREATE TABLE part(id TEXT,message_id TEXT,data TEXT)",
  );
  db.prepare("INSERT INTO session VALUES(?,?,?,?,NULL)").run("s", cwd, "title", 1);
  for (let i = 0; i < 100; i++)
    db.prepare("INSERT INTO message VALUES(?,?,?,?)").run(
      "m" + i,
      "s",
      i,
      JSON.stringify({ role: "user", content: "paused" }),
    );
  for (let i = 0; i < 100; i++)
    db.prepare("INSERT INTO part VALUES(?,?,?)").run(
      "p" + i,
      "m" + i,
      JSON.stringify({ type: "text", text: "paused" }),
    );
  db.close();
  const service = await env.start([{ id: "oc", provider: "opencode", homeDir: home }]);
  await service.scan();
  const source = (await service.list({ type: "history.list", cwd })).sessions[0];
  if (!source) throw new Error("Missing source");
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const sink = memorySink();
  const importing = service.importSession(init(source.id), {
    ...sink,
    appendItem: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  // Surface worker/import failures instead of waiting forever for a sink it never reached.
  await Promise.race([
    entered.promise,
    importing.then(() => {
      throw new Error("Import finished before reaching the paused sink");
    }),
  ]);
  try {
    await service.close();
  } finally {
    release.resolve();
  }
  await expect(importing).rejects.toThrow("closed");
  expect(
    (await readdir(join(env.root, "ace"))).filter((p) => p.startsWith("sqlite-read-")),
  ).toEqual([]);
  expect(sink.rolledBack).toBe(true);
});
test("a rejected index path creates no directories within a provider home", async () => {
  const env = await environment();
  cleanup.push(env.close);
  await expect(
    env.start([{ id: "account", provider: "claude", homeDir: env.root }]),
  ).rejects.toThrow("outside provider homes");
  expect(await readdir(env.root)).toEqual([]);
});
test("truncated small transcripts never claim an exact message count", async () => {
  const { service, path, source } = await setup();
  await appendFile(path, '{"type":"assistant"');
  await service.scan();
  expect((await service.get(source.id))?.countAccuracy).toBe("sampled");
});
test("native raw data is retained once across split text fragments", async () => {
  const { service, path, source } = await setup();
  await jsonl(path, claudeRecords("x".repeat(63127)));
  await service.scan();
  const sink = memorySink();
  await service.importSession(init(source.id), sink);
  const messages = sink.items.filter((i) => i.type === "message" && i.role === "user");
  expect(messages.reduce((n, i) => n + ("raw" in i ? i.raw.length : 0), 0)).toBe(1);
  expect(messages.reduce((n, i) => n + Buffer.byteLength(JSON.stringify(i)), 0)).toBeLessThan(
    160000,
  );
});

test("oversized sink items are rejected before any thread becomes visible", async () => {
  const { service, source } = await setup();
  const sink = service.archiveSink();
  await expect(
    service.importSession(init(source.id), {
      ...sink,
      appendItem: (item) =>
        sink.appendItem(
          item.type === "message"
            ? { ...item, parts: [{ type: "text", text: "x".repeat(300000) }] }
            : item,
        ),
    }),
  ).rejects.toThrow("publication limit");
  expect(await service.importedThread(init(source.id).threadId)).toBeNull();
  await service.importSession(init(source.id));
  expect(await service.importedThread(init(source.id).threadId)).not.toBeNull();
});

for (const [name, output] of [
  ["multibyte", "😺".repeat(2000) + "Z"],
  ["JSON escaped", "\u0000".repeat(5000)],
])
  test(`${name} result tails stay bounded while full output remains lossless`, async () => {
    const { service, source, path } = await setup("codex");
    await jsonl(path, [
      ...codexRecords(),
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "tool1",
          output,
        },
      },
    ]);
    await service.scan();
    await service.importSession(init(source.id));
    const call = (await service.itemsPage({ threadId: init(source.id).threadId })).items.find(
      (item) => item.type === "tool_call",
    );
    if (call?.type !== "tool_call" || call.call.detail.kind !== "shell" || !call.call.detail.output)
      throw new Error("Missing completed shell output");
    const summary = call.call.detail.output;
    expect(Buffer.byteLength(summary.tail)).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(JSON.stringify(summary.tail)) - 2).toBeLessThanOrEqual(4096);
    expect(summary.tail).not.toContain("\uFFFD");
    expect(summary.truncated).toBe(true);
    const blob = await service.readBlob({ id: summary.streamId, offset: 0, limit: 256 * 1024 });
    expect(Buffer.from(blob.bytes).toString()).toBe(output);
  });
