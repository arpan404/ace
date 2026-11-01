import { SettingsService, fileIO } from "@ace/settings";
import { fixture } from "./socket-test-support.ts";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { Agent } from "@ace/protocol";
import { expect, test } from "vitest";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";

// A real persisted database is necessary to exercise the upgrade and SQLite readers together.
test("upgrading an unfinished Offshift run settles stale work and preserves old events and items", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-upgrade-"));
  const path = join(root, "events.sqlite");
  let store = new Store(path);
  try {
    const settingsPath = join(root, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({
        version: 2,
        settings: {
          "offshift.enabled": true,
          offshift: { lastRun: "old" },
          "threads.settleOnClose": true,
          "future.preference": 42,
        },
      }),
    );
    const settings = new SettingsService({
      dataDir: root,
      io: { ...fileIO, watch: async () => () => {} },
    });
    try {
      expect(await settings.get("threads.settleOnClose")).toMatchObject({ value: true });
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
        version: 2,
        settings: {
          "threads.settleOnClose": true,
          "future.preference": 42,
        },
      });
    } finally {
      await settings.close();
    }
    const workspace = store.createWorkspace(root, "Upgrade", 1);
    const thread = createDevThread(store, workspace);
    const active = createDevThread(store, workspace);
    const agent = Agent.parse({
      id: "active-agent",
      threadId: active.id,
      parentId: null,
      origin: "root",
      native: { provider: "codex" },
      fidelity: "full",
      cwd: root,
      status: { state: "working", activity: "thinking" },
      createdAt: 1,
    });
    store.appendEvents(active.id, [{ type: "agent.created", agent }], 2);
    const head = store.headSeq();
    await store.close();
    const db = new DatabaseSync(path);
    try {
      // Reconstruct the previous release: before both the workflow removal and the later
      // machine-child liveness step, so undo that step's columns too.
      db.exec(`DROP INDEX IF EXISTS machine_children_seen;
        DROP INDEX IF EXISTS machine_children_stopping;
        ALTER TABLE machine_children DROP COLUMN seen_at;
        ALTER TABLE machine_children DROP COLUMN silent_since;
        ALTER TABLE machine_children DROP COLUMN stop_started_at;
        ALTER TABLE machine_children DROP COLUMN stop_attempts;
        ALTER TABLE machine_children DROP COLUMN stop_last_at;
        ALTER TABLE machine_children DROP COLUMN stopped_unconfirmed;
        UPDATE schema_version SET version=version-2;
        CREATE TABLE offshift_runs(thread_id TEXT,id TEXT,body TEXT,PRIMARY KEY(thread_id,id));
        CREATE TABLE offshift_receipts(thread_id TEXT,run_id TEXT,request_id TEXT,input TEXT);
      `);
      for (const id of [thread.id, active.id]) {
        db.prepare("INSERT INTO offshift_runs VALUES (?, 'run', ?)").run(
          id,
          JSON.stringify({ phase: "implement", state: "open" }),
        );
        db.prepare("UPDATE threads SET status=?,provider_metadata=? WHERE id=?").run(
          JSON.stringify({ state: "working", agents: 1 }),
          JSON.stringify({ run: { phase: "implement", state: "open" } }),
          id,
        );
      }
      const payload = { type: "offshift.updated", card: { id: "run", future: "retained" } };
      db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)").run(
        head + 1,
        "retired-event",
        thread.id,
        3,
        payload.type,
        JSON.stringify(payload),
      );
      db.prepare("UPDATE host_sequence SET seq=? WHERE id=1").run(head + 1);
      const item = {
        id: "old-item",
        agentId: "old-agent",
        createdAt: 3,
        type: "offshift",
        record: { outcome: "keep this" },
      };
      db.prepare("INSERT INTO items VALUES (?, ?, ?, ?)").run(
        item.id,
        thread.id,
        head + 1,
        JSON.stringify(item),
      );
      db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)").run(
        head + 2,
        "retired-item-event",
        thread.id,
        4,
        "item.created",
        JSON.stringify({ type: "item.created", item }),
      );
      db.prepare("UPDATE host_sequence SET seq=? WHERE id=1").run(head + 2);
      db.prepare(
        "INSERT INTO item_heads(id,thread_id,created_seq,size,item_type,text_prefix,text_last_unit,agent_id) VALUES(?,?,?,?,?,0,-1,?)",
      ).run(item.id, thread.id, head + 1, JSON.stringify(item).length, item.type, item.agentId);
    } finally {
      db.close();
    }
    store = new Store(path);
    expect(store.getThread(thread.id)?.status).toEqual({ state: "done" });
    // Removing a workflow must never settle a real live agent tree.
    expect(store.getThread(active.id)?.status.state).toBe("working");
    expect(() =>
      store.readSearchPage({ afterSeq: head, limit: 10, maxBytes: 256 * 1024 }),
    ).not.toThrow();
    const events = store.readEvents({ afterSeq: head, threadId: thread.id, limit: 10 });
    expect(events).toHaveLength(2);
    expect(events[1]?.payload).toMatchObject({
      type: "item.created",
      item: { type: "unknown", data: { type: "offshift", record: { outcome: "keep this" } } },
    });
    expect(events[0]?.payload).toEqual({
      type: "unknown",
      raw: { type: "offshift.updated", card: { id: "run", future: "retained" } },
    });
    expect(store.readItems(thread.id, Number.MAX_SAFE_INTEGER, 10).items).toContainEqual(
      expect.objectContaining({
        type: "unknown",
        data: expect.objectContaining({ type: "offshift", record: { outcome: "keep this" } }),
      }),
    );
    await store.close();
    store = new Store(path);
    expect(store.getThread(thread.id)?.status.state).toBe("done");
    expect(store.readEvents({ afterSeq: head, threadId: thread.id, limit: 10 })).toEqual(events);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
  const server = await fixture();
  try {
    const client = await server.connect();
    expect(await client.next()).toMatchObject({ type: "welcome" });
    client.socket.send(
      JSON.stringify({
        type: "offshift.request",
        requestId: "retired",
        threadId: server.thread.id,
        op: { action: "get", runId: "run" },
      }),
    );
    expect(await client.next()).toMatchObject({
      type: "error",
      code: "unsupported",
      requestId: "retired",
    });
    client.send({ type: "ping" });
    expect(await client.next()).toMatchObject({ type: "pong" });
  } finally {
    await server.close();
  }
});
