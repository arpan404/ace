import { afterEach, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createLogger } from "@ace/diagnostics";
import { Agent, type ServerMessage } from "@ace/protocol";
import { Store } from "./store.ts";
import { openDaemonHistory, IDLE_MS } from "./history.ts";
import { createDevThread } from "./commands.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
const cwd = "/past-sessions";
const signal = () => new AbortController().signal;

async function fixture(options: { log?: ReturnType<typeof createLogger> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ace-history-on-demand-"));
  const data = join(root, "ace"),
    home = join(root, "claude");
  await mkdir(join(home, "projects/p"), { recursive: true });
  await mkdir(data);
  for (const [id, prompt] of [
    ["saved", "Plan the relay migration"],
    ["ace-started", "Started inside ace"],
  ])
    await writeFile(
      join(home, `projects/p/${id}.jsonl`),
      JSON.stringify({
        type: "user",
        sessionId: id,
        cwd,
        timestamp: "2026-01-01T00:00:00Z",
        message: { role: "user", content: prompt },
      }) + "\n",
    );
  const store = new Store(join(data, "events.sqlite"));
  const timers: (() => void)[] = [];
  let id = 0;
  const history = await openDaemonHistory(data, store, {
    instances: [{ id: "claude-default", provider: "claude", homeDir: home }],
    now: () => 1000,
    nextId: () => `id-${++id}`,
    schedule: (run, milliseconds) => {
      expect(milliseconds).toBe(IDLE_MS);
      timers.push(run);
      return () => timers.splice(timers.indexOf(run), 1);
    },
    ...(options.log ? { log: options.log.child("history") } : {}),
  });
  cleanup.push(async () => {
    await history.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const workingFiles = async () =>
    (await readdir(join(data, "tmp")).catch(() => [])).filter((name) =>
      name.startsWith("past-sessions-"),
    );
  return { data, store, history, timers, workingFiles };
}
function sessions(reply: ServerMessage) {
  if (reply.type !== "history.list") throw new Error("Missing past sessions");
  return reply.sessions;
}

test("Find past sessions in Settings lists provider sessions on demand, excluding ace-started ones", async () => {
  const f = await fixture();
  // Opening the history service reads nothing and keeps nothing.
  expect(f.history.open).toBe(false);
  expect(await f.workingFiles()).toEqual([]);
  // A thread started in ace already holds the provider session "ace-started".
  const workspaceId = f.store.createWorkspace(cwd, "Past sessions");
  const thread = createDevThread(f.store, workspaceId, "Started in ace", "claude");
  f.store.appendEvents(thread.id, [
    {
      type: "agent.created",
      agent: Agent.parse({
        id: "root",
        threadId: thread.id,
        parentId: null,
        origin: "root",
        native: { provider: "claude", nativeId: "ace-started" },
        fidelity: "full",
        cwd,
        status: { state: "idle" },
        createdAt: 1,
      }),
    },
  ]);
  const found = await f.history.handle(
    { type: "history.list", cwd, limit: 10, rescan: true },
    signal(),
  );
  expect(sessions(found).map((session) => session.nativeId)).toEqual(["saved"]);
  expect(f.history.open).toBe(true);
});

test("importing a session creates exactly one ace thread", async () => {
  const f = await fixture();
  const workspaceId = f.store.createWorkspace(cwd, "Past sessions");
  const source = sessions(
    await f.history.handle({ type: "history.list", cwd, limit: 10 }, signal()),
  ).find((session) => session.nativeId === "saved");
  if (!source) throw new Error("Missing saved session");
  const request = { type: "history.import" as const, sourceId: source.id, workspaceId };
  const first = await f.history.handle(request, signal());
  const second = await f.history.handle(request, signal());
  expect(first).toMatchObject({ type: "history.import", status: "imported" });
  expect(second).toEqual(first);
  const imported = f.store.atomic((db) =>
    z
      .array(z.object({ id: z.string() }))
      .parse(db.prepare("SELECT id FROM threads WHERE imported IS NOT NULL").all()),
  );
  expect(imported).toHaveLength(1);
  // Once imported, the session is in ace and is not offered again.
  const again = await f.history.handle(
    { type: "history.list", cwd, limit: 10, rescan: true },
    signal(),
  );
  expect(sessions(again).map((session) => session.nativeId)).toEqual(["ace-started"]);
});

test("leaving the page persists nothing", async () => {
  const f = await fixture();
  const workspaceId = f.store.createWorkspace(cwd, "Past sessions");
  const found = sessions(
    await f.history.handle({ type: "history.list", cwd, limit: 10 }, signal()),
  );
  expect(found).toHaveLength(2);
  expect(await f.workingFiles()).toHaveLength(1);
  expect(await f.history.handle({ type: "history.release" }, signal())).toEqual({
    type: "history.release",
  });
  expect(f.history.open).toBe(false);
  expect(await f.workingFiles()).toEqual([]);
  expect(existsSync(join(f.data, "history"))).toBe(false);
  expect(f.store.headSeq()).toBe(0);
  // A choice made after leaving needs a fresh look, not a remembered list.
  expect(
    await f.history.handle(
      { type: "history.import", sourceId: found[0]?.id ?? "", workspaceId },
      signal(),
    ),
  ).toMatchObject({ type: "history.import", status: "unsupported" });
  expect(await f.workingFiles()).toEqual([]);
});

test("a page that never says goodbye has its session ended after ten idle minutes", async () => {
  const f = await fixture();
  await f.history.handle({ type: "history.list", cwd, limit: 10 }, signal());
  expect(f.timers).toHaveLength(1);
  f.timers[0]?.();
  await expect.poll(() => f.workingFiles()).toEqual([]);
  expect(f.history.open).toBe(false);
});

test("a failed look through history leaves a useful diagnostic instead of failing silently", async () => {
  const log = createLogger({
    sink: { async write() {}, async close() {} },
    now: () => 10,
    redact: (line) => line,
  });
  cleanup.push(() => log.close());
  const f = await fixture({ log });
  await expect(
    f.history.handle(
      { type: "history.list", cwd, limit: 10, before: { lastActivity: -1, id: "" } },
      signal(),
    ),
  ).rejects.toThrow();
  expect(
    log
      .recent()
      .map((line) =>
        z
          .object({ level: z.string(), message: z.string(), data: z.unknown() })
          .parse(JSON.parse(line)),
      ),
  ).toContainEqual(
    expect.objectContaining({
      level: "warn",
      message: "Past sessions operation failed",
      data: expect.objectContaining({ operation: "history.list" }),
    }),
  );
});
