import { afterEach, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import {
  environment,
  init,
  cwd,
  nativeId,
  otherId,
  jsonl,
  codexRecords,
  text,
} from "./test-support.ts";
import { object, readJsonLines } from "@ace/native-session";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function database() {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "opencode");
  await mkdir(home);
  const path = join(home, "opencode.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,title TEXT,time_updated INTEGER,parent_id TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
    CREATE INDEX message_session ON message(session_id,time_created,id);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,data TEXT);
    CREATE INDEX part_message ON part(message_id,id);`);
  const session = db.prepare("INSERT INTO session VALUES(?,?,?,?,?)");
  const message = db.prepare("INSERT INTO message VALUES(?,?,?,?)");
  const part = db.prepare("INSERT INTO part VALUES(?,?,?)");
  session.run("session-root", cwd, "OpenCode title", 98765, null);
  session.run("session-child", cwd, "Child", 99999, "session-root");
  message.run("m1", "session-root", 1, JSON.stringify({ role: "user", time: { created: 1 } }));
  message.run(
    "m2",
    "session-root",
    2,
    JSON.stringify({ role: "assistant", modelID: "opencode-model", time: { created: 2 } }),
  );
  part.run("p1", "m1", JSON.stringify({ type: "text", text: "OpenCode prompt" }));
  part.run(
    "p2",
    "m2",
    JSON.stringify({
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { filePath: "file.ts" }, output: "file content" },
    }),
  );
  part.run("p3", "m2", JSON.stringify({ type: "text", text: "OpenCode answer" }));
  return { ...env, home, path, db };
}
test("OpenCode databases import ordered messages, tool outputs and child sessions read-only", async () => {
  const { start, home, path, db } = await database();
  db.close();
  const before = await readFile(path);
  const service = await start([
    { id: "oc", provider: "opencode", homeDir: home, offlineSnapshot: true },
  ]);
  expect((await service.scan()).unsupported).toEqual([]);
  const sources = (await service.list({ type: "history.list", cwd })).sessions;
  const root = sources.find((s) => s.nativeId === "session-root");
  if (!root) throw new Error("missing root");
  expect(root).toMatchObject({
    title: "OpenCode title",
    messageCount: 2,
    model: "opencode-model",
    lastActivity: 99999,
    countAccuracy: "exact",
  });
  expect(await service.importSession(init(root.id))).toEqual({
    messageCount: 2,
    countAccuracy: "exact",
  });
  const items = (await service.itemsPage({ threadId: init(root.id).threadId })).items;
  expect(text(items)).toContain("OpenCode prompt");
  expect(items.some((i) => i.type === "notice" && i.text.includes("file content"))).toBe(true);
  expect(text(items)).toContain("OpenCode answer");
  expect(items.some((i) => i.type === "tool_call" && i.call.title === "read")).toBe(true);
  expect(await service.importedAgents(init(root.id).threadId)).toHaveLength(2);
  expect(await readFile(path)).toEqual(before);
  expect((await service.scan()).reads).toBe(0);
});
test("live SQLite WAL changes refresh the index and include committed messages", async () => {
  const { start, home, db, path } = await database();
  cleanup.push(async () => db.close());
  db.exec("PRAGMA journal_mode=WAL; UPDATE session SET time_updated=time_updated+1");
  const service = await start([{ id: "oc", provider: "opencode", homeDir: home }]);
  await service.scan();
  const before = await readFile(path);
  const walBefore = await readFile(path + "-wal");
  db.prepare("INSERT INTO message VALUES(?,?,?,?)").run(
    "m3",
    "session-root",
    3,
    JSON.stringify({ role: "user" }),
  );
  const walAfter = await readFile(path + "-wal");
  const shmAfter = await readFile(path + "-shm");
  expect(walAfter).not.toEqual(walBefore);
  await service.scan();
  const s = (await service.list({ type: "history.list", cwd })).sessions.find(
    (r) => r.nativeId === "session-root",
  );
  expect(s?.messageCount).toBe(3);
  expect(await readFile(path)).toEqual(before);
  expect(await readFile(path + "-wal")).toEqual(walAfter);
  expect(await readFile(path + "-shm")).toEqual(shmAfter);
});
test("immutable SQLite refuses a live WAL and reports a safe unsupported reason", async () => {
  const { start, home, db } = await database();
  cleanup.push(async () => db.close());
  db.exec("PRAGMA journal_mode=WAL; UPDATE session SET time_updated=time_updated+1");
  const service = await start([
    { id: "oc", provider: "opencode", homeDir: home, offlineSnapshot: true },
  ]);
  expect((await service.scan()).unsupported[0]?.reason).toContain("WAL or journal");
});
test("Codex state metadata lists database-only sessions and avoids duplicating rollouts", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "codex");
  await jsonl(join(home, "sessions/2026/01/01/rollout.jsonl"), codexRecords());
  const db = new DatabaseSync(join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads(id TEXT,cwd TEXT,title TEXT,updated_at INTEGER)");
  const stmt = db.prepare("INSERT INTO threads VALUES(?,?,?,?)");
  stmt.run(nativeId, cwd, "same rollout", 10);
  stmt.run(otherId, cwd, "database-only", 20);
  db.close();
  const service = await env.start([{ id: "codex", provider: "codex", homeDir: home }]);
  await service.scan();
  const rows = (await service.list({ type: "history.list", cwd })).sessions;
  expect(rows).toHaveLength(2);
  expect(rows.find((s) => s.nativeId === otherId)).toMatchObject({
    title: "database-only",
    lastActivity: 20000,
    support: { status: "unsupported" },
  });
  expect(rows.find((s) => s.nativeId === nativeId)?.support.status).toBe("supported");
});
test("unknown database schemas return unsupported without rewriting provider bytes", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "oc");
  await mkdir(home);
  const path = join(home, "opencode.db");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE mystery(data TEXT)");
  db.close();
  const before = await readFile(path);
  const service = await env.start([{ id: "oc", provider: "opencode", homeDir: home }]);
  expect((await service.scan()).unsupported[0]?.reason).toContain("schema");
  expect(await readFile(path)).toEqual(before);
});
test("OpenCode v2 history is explicitly unsupported rather than an empty successful import", async () => {
  const { start, home, db } = await database();
  db.exec(
    "CREATE TABLE session_message(session_id TEXT);INSERT INTO session_message VALUES('session-root')",
  );
  db.close();
  const service = await start([{ id: "oc", provider: "opencode", homeDir: home }]);
  await service.scan();
  const s = (await service.list({ type: "history.list", cwd })).sessions.find(
    (r) => r.nativeId === "session-root",
  );
  expect(s?.support).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("v2"),
  });
});
test("fixture-derived OpenCode parts retain observed text and tool results", async () => {
  const { start, home, db } = await database();
  const statements = db.prepare("INSERT OR REPLACE INTO part VALUES(?,?,?)");
  const expected: string[] = [];
  const fixtures = new URL("../../../fixtures", import.meta.url).pathname;
  const path = join(fixtures, "opencode/1.18.33/tool-read.jsonl");
  for await (const record of readJsonLines(fixtures, path)) {
    if (!("value" in record)) continue;
    const payload = object(object(object(record.value).data).payload);
    const part = object(object(payload.properties).part);
    if (payload.type !== "message.part.updated" || typeof part.id !== "string") continue;
    statements.run(part.id, "m2", JSON.stringify(part));
    if (part.type === "text" && typeof part.text === "string") expected.push(part.text);
  }
  db.close();
  expect(expected.length).toBeGreaterThan(0);
  const service = await start([{ id: "oc", provider: "opencode", homeDir: home }]);
  await service.scan();
  const s = (await service.list({ type: "history.list", cwd })).sessions.find(
    (r) => r.nativeId === "session-root",
  );
  if (!s) throw new Error("missing");
  await service.importSession(init(s.id));
  const content = text((await service.itemsPage({ threadId: init(s.id).threadId })).items);
  expect(content).toContain(expected.at(-1));
});
test("fixture-derived Codex response items retain assistant text", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "codex"),
    path = join(home, "sessions/2026/01/01/rollout.jsonl");
  const fixtures = new URL("../../../fixtures", import.meta.url).pathname;
  const records: unknown[] = [{ type: "session_meta", payload: { id: nativeId, cwd } }];
  const expected: string[] = [];
  for await (const record of readJsonLines(
    fixtures,
    join(fixtures, "codex/0.159.1/tool-read.jsonl"),
  )) {
    if (!("value" in record)) continue;
    const data = object(object(record.value).data);
    const item = object(object(data.params).item);
    if (
      data.method === "item/completed" &&
      item.type === "agentMessage" &&
      typeof item.text === "string"
    ) {
      expected.push(item.text);
      records.push({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: item.text }],
        },
      });
    }
  }
  expect(expected.length).toBeGreaterThan(0);
  await jsonl(path, records);
  const service = await env.start([{ id: "cx", provider: "codex", homeDir: home }]);
  await service.scan();
  const s = (await service.list({ type: "history.list", cwd })).sessions[0];
  if (!s) throw new Error("missing");
  await service.importSession(init(s.id));
  expect(text((await service.itemsPage({ threadId: init(s.id).threadId })).items)).toContain(
    expected.at(-1),
  );
});

test("legacy OpenCode storage imports user text and counts native messages", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "legacy");
  await jsonl(join(home, "storage/session/project/session-root.json"), [
    { id: "session-root", directory: cwd, title: "legacy", time: { updated: 900 } },
  ]);
  await jsonl(join(home, "storage/message/session-root/message-user.json"), [
    { id: "message-user", sessionID: "session-root", role: "user" },
  ]);
  await jsonl(join(home, "storage/part/message-user/part-text.json"), [
    { type: "text", text: "legacy prompt" },
  ]);
  const service = await env.start([{ id: "legacy", provider: "opencode", homeDir: home }]);
  await service.scan();
  const s = (await service.list({ type: "history.list", cwd })).sessions[0];
  if (!s) throw new Error("missing");
  expect(await service.importSession(init(s.id))).toMatchObject({ messageCount: 1 });
  const items = (await service.itemsPage({ threadId: init(s.id).threadId })).items;
  expect(
    items.some(
      (i) =>
        i.type === "message" &&
        i.role === "user" &&
        i.parts.some((p) => p.type === "text" && p.text === "legacy prompt"),
    ),
  ).toBe(true);
});
test("malformed SQLite records survive in a raw blob without hiding other messages", async () => {
  const { start, home, db } = await database();
  db.prepare("INSERT INTO part VALUES(?,?,?)").run("bad", "m2", '{"future":');
  db.close();
  const service = await start([{ id: "oc", provider: "opencode", homeDir: home }]);
  await service.scan();
  const s = (await service.list({ type: "history.list", cwd })).sessions.find(
    (r) => r.nativeId === "session-root",
  );
  if (!s) throw new Error("missing");
  await service.importSession(init(s.id));
  const items = (await service.itemsPage({ threadId: init(s.id).threadId })).items;
  expect(text(items)).toContain("OpenCode answer");
  const entry = items.find((i) => i.type === "notice" && i.text.includes("incomplete JSON"));
  const raw = entry?.type === "notice" ? object(entry.raw[0]?.data) : {};
  expect(
    Buffer.from(
      (await service.readBlob({ id: String(raw.blobRef), offset: 0, limit: 100 })).bytes,
    ).toString(),
  ).toBe('{"future":');
});

test("giant SQLite scalar records are refused before an unbounded native allocation", async () => {
  const { start, home, db } = await database();
  db.prepare("INSERT INTO part VALUES(?,?,?)").run(
    "huge",
    "m2",
    JSON.stringify({ type: "text", text: "x".repeat(2 * 1024 * 1024) }),
  );
  db.close();
  const service = await start([{ id: "oc", provider: "opencode", homeDir: home }]);
  await service.scan();
  const s = (await service.list({ type: "history.list", cwd })).sessions.find(
    (r) => r.nativeId === "session-root",
  );
  expect(s?.support).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("bounded decoder"),
  });
});
