import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { DeviceId, type ServerMessage } from "@ace/protocol";
import { Client } from "./socket-test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
const cwd = "/synthetic/workspace";
const lines = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");

/** A HOME holding saved Claude, Codex and OpenCode sessions, as a person's machine would. */
async function providerHome() {
  const root = await mkdtemp(join(tmpdir(), "ace-history-startup-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const claude = join(home, ".claude"),
    codex = join(home, ".codex"),
    opencode = join(home, ".local/share/opencode");
  await mkdir(join(claude, "projects/p"), { recursive: true });
  await writeFile(
    join(claude, "projects/p/claude-session.jsonl"),
    lines([
      {
        type: "user",
        sessionId: "claude-session",
        cwd,
        timestamp: "2026-01-01T00:00:00Z",
        message: { role: "user", content: "Plan the relay migration" },
      },
    ]),
  );
  await mkdir(join(codex, "sessions/2026/01/01"), { recursive: true });
  await writeFile(
    join(codex, "sessions/2026/01/01/rollout-codex.jsonl"),
    lines([
      { type: "session_meta", payload: { id: "codex-session", cwd } },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      },
    ]),
  );
  await mkdir(opencode, { recursive: true });
  const db = new DatabaseSync(join(opencode, "opencode.db"));
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,title TEXT,time_updated INTEGER,parent_id TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,data TEXT);`);
  db.prepare("INSERT INTO session VALUES(?,?,?,?,NULL)").run("oc-session", cwd, "OpenCode", 1);
  db.close();
  return { root, home, claude, codex, opencode };
}
async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Exceeded ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function next(client: Client, predicate: (message: ServerMessage) => boolean) {
  for (;;) {
    const message = await client.next();
    if (predicate(message)) return message;
  }
}
async function launch(fixture: Awaited<ReturnType<typeof providerHome>>, readLog: string) {
  const aceHome = join(fixture.root, "ace");
  const child = spawn(
    process.execPath,
    [
      "--import",
      new URL("./history-reads.fixture.ts", import.meta.url).href,
      fileURLToPath(new URL("./cli.ts", import.meta.url)),
      "start",
    ],
    {
      env: {
        ...process.env,
        HOME: fixture.home,
        ACE_HOME: aceHome,
        // Where saved sessions live; locating a provider's CLI in HOME is not reading history.
        ACE_TEST_WATCH_ROOTS: JSON.stringify([
          join(fixture.claude, "projects"),
          join(fixture.codex, "sessions"),
          join(fixture.opencode, "opencode.db"),
        ]),
        ACE_TEST_READ_LOG: readLog,
        ACE_PORT: "0",
        ACE_LISTEN: "local",
        ACE_ACCOUNTS_DB: join(aceHome, "accounts.sqlite"),
        ACE_DEV: "0",
        ACE_LOG_LEVEL: "silent",
        ACE_MAINTENANCE: "0",
        ACE_MODEL_INSTANCES: "[]",
        ACE_RELAY_URL: undefined,
        ACE_SCREEN_HELPER: undefined,
        ACE_APNS_KEY_FILE: "",
        ACE_VAPID_KEY_FILE: "",
        ACE_WORKSPACE_ROOT: "",
        PATH: "",
        ACE_HISTORY_INSTANCES: JSON.stringify([
          { id: "claude-default", provider: "claude", homeDir: fixture.claude },
          { id: "codex-default", provider: "codex", homeDir: fixture.codex },
          { id: "opencode-default", provider: "opencode", homeDir: fixture.opencode },
        ]),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const exited = once(child, "close");
  let errors = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  let output = "";
  await bounded(
    new Promise<void>((resolve, reject) => {
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (/ace daemon: ws:\/\/127\.0\.0\.1:\d+\n/.test(output)) resolve();
      });
      void exited.then(() => reject(new Error(`Daemon exited: ${errors}`)));
    }),
    8000,
  );
  const origin = await readFile(join(aceHome, "daemon-endpoint"), "utf8");
  const token = await readFile(join(aceHome, "daemon-token"), "utf8");
  const client = new Client(origin.replace("http:", "ws:"));
  cleanups.push(() => client.close());
  await bounded(once(client.socket, "open"), 1000);
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("history-startup"),
    token,
  });
  await bounded(
    next(client, (message) => message.type === "welcome"),
    1000,
  );
  return { child, exited, client, aceHome };
}
const reads = async (log: string) =>
  (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
async function workingFiles(aceHome: string) {
  const names = await readdir(join(aceHome, "tmp")).catch(() => []);
  return names.filter((name) => name.startsWith("past-sessions-"));
}

it("daemon startup reads no provider history files and creates no history index", async () => {
  const fixture = await providerHome();
  const log = join(fixture.root, "reads.log");
  const daemon = await launch(fixture, log);
  // A request that every connected client sends, after the services are listening.
  daemon.client.send({ type: "ping" });
  await bounded(
    next(daemon.client, (message) => message.type === "pong"),
    2000,
  );
  expect(await reads(log)).toEqual([]);
  expect(existsSync(join(daemon.aceHome, "history"))).toBe(false);
  expect(await workingFiles(daemon.aceHome)).toEqual([]);

  // The same recorder sees provider files as soon as the person asks for past sessions.
  daemon.client.send({ type: "history.list", requestId: "find", cwd, limit: 10, rescan: true });
  const found = await bounded(
    next(daemon.client, (m) => m.type === "history.list" && m.requestId === "find"),
    20_000,
  );
  if (found.type !== "history.list") throw new Error("Missing past sessions");
  expect(found.sessions.map((session) => session.nativeId)).toContain("claude-session");
  expect((await reads(log)).length).toBeGreaterThan(0);

  // Leaving the page ends the session: nothing it read is kept in ACE_HOME.
  daemon.client.send({ type: "history.release", requestId: "leave" });
  await bounded(
    next(daemon.client, (m) => m.type === "history.release" && m.requestId === "leave"),
    5000,
  );
  expect(await workingFiles(daemon.aceHome)).toEqual([]);
  expect(existsSync(join(daemon.aceHome, "history"))).toBe(false);
  daemon.child.kill("SIGTERM");
  const [code, signal] = await bounded(daemon.exited, 5000);
  expect({ code, signal }).toEqual({ code: 0, signal: null });
}, 40_000);
