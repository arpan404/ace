import { afterEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { SnapshotScratch } from "./snapshot-scratch.ts";
import { environment, init, jsonl, memorySink, text } from "./test-support.ts";

// Each CLI's own layout under a Windows profile folder, with the drive-letter workspace its
// sessions record. Claude names the project folder after the cwd with every non-alphanumeric
// character as `-`; ace reads the cwd from the records, never from that name.
const windows = process.platform === "win32";
const cwd = "C:\\work\\app";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function profile() {
  const env = await environment();
  cleanup.push(env.close);
  const user = join(env.root, "Users", "person");
  const claude = join(user, ".claude");
  const codex = join(user, ".codex");
  const pi = join(user, ".pi", "agent");
  const opencode = join(user, ".local", "share", "opencode");
  await jsonl(join(claude, "projects", "C--work-app", "claude-1.jsonl"), [
    {
      type: "user",
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd,
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "claude on windows" },
    },
    {
      type: "assistant",
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd,
      message: {
        role: "assistant",
        model: "claude-model",
        content: [{ type: "text", text: "ok" }],
      },
    },
  ]);
  await jsonl(join(codex, "sessions", "2026", "01", "01", "rollout-2026-01-01-codex.jsonl"), [
    { type: "session_meta", payload: { id: "22222222-2222-4222-8222-222222222222", cwd } },
    { type: "turn_context", payload: { model: "codex-model", cwd } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "codex on windows" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "codex answer" }],
      },
    },
  ]);
  await jsonl(join(pi, "sessions", "--C--work-app--", "pi.jsonl"), [
    { type: "session", version: 3, id: "pi-session", cwd },
    { type: "model_change", id: "m", parentId: null, provider: "anthropic", modelId: "pi-model" },
    {
      type: "message",
      id: "ask",
      parentId: "m",
      message: { role: "user", content: "pi on windows" },
    },
    {
      type: "message",
      id: "answer",
      parentId: "ask",
      message: { role: "assistant", content: [{ type: "text", text: "pi answer" }] },
    },
  ]);
  await mkdir(opencode, { recursive: true });
  const db = new DatabaseSync(join(opencode, "opencode.db"));
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,title TEXT,time_updated INTEGER,parent_id TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
    CREATE INDEX message_session ON message(session_id,time_created,id);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,data TEXT);
    CREATE INDEX part_message ON part(message_id,id);`);
  db.prepare("INSERT INTO session VALUES(?,?,?,?,?)").run("oc-session", cwd, "OpenCode", 5, null);
  db.prepare("INSERT INTO message VALUES(?,?,?,?)").run(
    "m1",
    "oc-session",
    1,
    JSON.stringify({ role: "user", time: { created: 1 } }),
  );
  db.prepare("INSERT INTO part VALUES(?,?,?)").run(
    "p1",
    "m1",
    JSON.stringify({ type: "text", text: "opencode on windows" }),
  );
  db.close();
  return { env, claude, codex, pi, opencode };
}

test.runIf(windows)(
  "Windows: every provider's sessions under the profile folder list for a drive-letter workspace",
  async () => {
    const homes = await profile();
    const service = await homes.env.start([
      { id: "claude", provider: "claude", homeDir: homes.claude },
      { id: "codex", provider: "codex", homeDir: homes.codex },
      { id: "pi", provider: "pi", homeDir: homes.pi },
      { id: "oc", provider: "opencode", homeDir: homes.opencode, offlineSnapshot: true },
    ]);
    await service.scan();
    const sessions = (await service.list({ type: "history.list", cwd })).sessions;
    expect(sessions.map((s) => s.provider).toSorted()).toEqual([
      "claude",
      "codex",
      "opencode",
      "pi",
    ]);
    for (const session of sessions) expect(session.cwd).toBe(cwd);
    const imported: Record<string, string> = {};
    for (const session of sessions) {
      const sink = memorySink();
      await service.importSession(init(session.id, `imported-${session.provider}`), sink);
      imported[session.provider] = text(sink.items);
    }
    expect(imported).toEqual({
      claude: expect.stringContaining("claude on windows"),
      codex: expect.stringContaining("codex on windows"),
      pi: expect.stringContaining("pi on windows"),
      opencode: expect.stringContaining("opencode on windows"),
    });
  },
);

test.runIf(windows)(
  "Windows: the startup sweep removes a dead process's snapshot stage and keeps a live one's",
  async () => {
    const env = await environment();
    cleanup.push(env.close);
    const root = join(env.root, "scratch");
    const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(exited, "exit");
    const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    cleanup.push(async () => {
      live.kill();
      if (live.exitCode === null) await once(live, "exit");
    });
    await mkdir(join(root, `sqlite-read-${exited.pid}-dead`), { recursive: true });
    await mkdir(join(root, `sqlite-read-${live.pid}-live`), { recursive: true });
    const removed = await new SnapshotScratch(root).sweep();
    expect(removed).toBe(1);
    expect(await readdir(root)).toEqual([`sqlite-read-${live.pid}-live`]);
  },
);
