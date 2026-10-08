import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { AdapterRegistry, Engine, Store } from "@ace/daemon";
import { createTurnProvider, ScriptedTurnConfig } from "@ace/adapter-testkit";
import { Command, Thread, ThreadId, WorkspaceId } from "@ace/protocol";
import { historicalStore, historicalStoreVersions } from "./historical-store-fixtures.ts";
import { ManualClock } from "./engine/test-support.ts";

const oldThread = Thread.parse({
  id: "historical",
  workspaceId: "w",
  title: "Preserved history",
  provider: "codex",
  status: { state: "new" },
  createdAt: 1,
  updatedAt: 1,
});

test.each(historicalStoreVersions)(
  "schema %s upgrades, preserves history and receipts, and runs a real engine turn after reopening",
  async (version) => {
    const home = await mkdtemp(join(tmpdir(), "ace-historical-upgrade-"));
    const path = join(home, "events.sqlite");
    const db = new DatabaseSync(path);
    let store: Store | undefined;
    let engine: Engine | undefined;
    const registry = new AdapterRegistry();
    try {
      historicalStore(db, version);
      if (version) {
        db.prepare("INSERT INTO workspaces VALUES ('w', ?, 'Existing project', 1)").run(home);
        db.prepare(`INSERT INTO threads(id,workspace_id,title,provider,status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?)`).run(
          oldThread.id,
          oldThread.workspaceId,
          oldThread.title,
          oldThread.provider,
          JSON.stringify(oldThread.status),
          1,
          1,
        );
        db.prepare(
          "INSERT INTO events VALUES (1,'old-event','historical',1,'thread.created',?)",
        ).run(JSON.stringify({ type: "thread.created", thread: oldThread }));
        db.prepare("INSERT INTO command_receipts VALUES ('old-command','device',1,?)").run(
          JSON.stringify({ commandId: "old-command", ok: true, threadId: oldThread.id }),
        );
        if (version >= 3) db.exec("UPDATE host_sequence SET seq=1 WHERE id=1");
      }
      db.close();
      store = new Store(path, undefined, { now: () => 1000 });
      const workspaceId = version
        ? WorkspaceId.parse("w")
        : store.createWorkspace(home, "New project");
      if (version) {
        expect(store.getThread(oldThread.id)).toMatchObject(oldThread);
        expect(store.readEvents({ afterSeq: 0, limit: 10 })).toMatchObject([
          { id: "old-event", seq: 1, payload: { type: "thread.created", thread: oldThread } },
        ]);
        const replay = store.recordCommand(
          Command.shape.id.parse("old-command"),
          Command.shape.deviceId.parse("device"),
          () => {
            throw new Error("An upgrade must preserve accepted command receipts");
          },
        );
        expect(replay).toMatchObject({ ok: true, threadId: oldThread.id });
        expect(
          store.appendEvents(
            oldThread.id,
            [{ type: "thread.updated", title: "After upgrade" }],
            2,
          )[0]?.seq,
        ).toBe(2);
      }
      await store.close();
      // A second open must neither repeat versioned DDL nor rewrite retained events.
      store = new Store(path, undefined, { now: () => 1000 });
      if (version) {
        expect(store.getThread(oldThread.id)?.title).toBe("After upgrade");
        expect(store.headSeq()).toBe(2);
      }
      const clock = new ManualClock();
      registry.register(
        createTurnProvider({
          provider: "codex",
          reply: "upgrade verified",
          config: ScriptedTurnConfig.parse({}),
          now: clock.now,
          schedule: () => () => {},
        }),
        { installed: true, auth: "logged_in", loginHint: "scripted" },
      );
      engine = new Engine(store, { registry, clock });
      await engine.flush();
      const command = Command.parse({
        id: "post-upgrade",
        deviceId: "device",
        payload: {
          type: "thread.create",
          threadId: "post-upgrade-thread",
          workspaceId,
          provider: "codex",
          title: "Post-upgrade work",
          input: [{ type: "text", text: "Continue" }],
        },
      });
      expect(engine.handler.handle(command, store)).toMatchObject({
        ok: true,
        threadId: "post-upgrade-thread",
      });
      await engine.flush();
      const createdId = ThreadId.parse("post-upgrade-thread");
      expect(store.getThread(createdId)?.status.state).toBe("done");
      expect(store.readItemPage(createdId, store.headSeq() + 1, 10).items).toContainEqual(
        expect.objectContaining({
          type: "message",
          role: "assistant",
          parts: [expect.objectContaining({ type: "text", text: "upgrade verified" })],
        }),
      );
      await engine.close();
      engine = undefined;
      await store.close();
      store = new Store(path, undefined, { now: () => 1000 });
      expect(store.getThread(createdId)?.status.state).toBe("done");
      if (version) expect(store.getThread(oldThread.id)?.title).toBe("After upgrade");
    } finally {
      if (db.isOpen) db.close();
      await engine?.close();
      await store?.close();
      await registry.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("an interrupted numbered upgrade rolls back and can retry without losing accepted history", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-upgrade-retry-"));
  const path = join(home, "events.sqlite");
  const db = new DatabaseSync(path);
  let store: Store | undefined;
  try {
    historicalStore(db, 12);
    db.prepare("INSERT INTO workspaces VALUES ('w', ?, 'Existing project', 1)").run(home);
    db.prepare(`INSERT INTO threads(id,workspace_id,title,provider,status,created_at,updated_at)
      VALUES ('historical','w','Preserved history','codex','{"state":"new"}',1,1)`).run();
    db.prepare("INSERT INTO events VALUES (1,'old-event','historical',1,'thread.created',?)").run(
      JSON.stringify({ type: "thread.created", thread: oldThread }),
    );
    db.exec(`UPDATE host_sequence SET seq=1 WHERE id=1;
      CREATE TRIGGER fail_upgrade BEFORE UPDATE OF version ON schema_version
      BEGIN SELECT RAISE(ABORT,'simulated upgrade interruption'); END;`);
    expect(() => {
      store = new Store(path);
    }).toThrow("simulated upgrade interruption");
    expect(db.prepare("SELECT version FROM schema_version WHERE id=1").get()).toMatchObject({
      version: 12,
    });
    expect(db.prepare("SELECT title FROM threads WHERE id='historical'").get()).toMatchObject({
      title: oldThread.title,
    });
    db.exec("DROP TRIGGER fail_upgrade");
    store = new Store(path);
    expect(store.getThread(oldThread.id)).toMatchObject(oldThread);
    expect(store.headSeq()).toBe(1);
    expect(
      db.prepare("SELECT version FROM schema_version WHERE id=1").get()?.version,
    ).toBeGreaterThan(12);
    // Once committed, a future open must not try the numbered step again.
    db.exec(`CREATE TRIGGER no_repeat BEFORE UPDATE OF version ON schema_version
      BEGIN SELECT RAISE(ABORT,'committed upgrade repeated'); END;`);
    await store.close();
    store = new Store(path);
    expect(store.getThread(oldThread.id)).toMatchObject(oldThread);
    expect(store.headSeq()).toBe(1);
  } finally {
    await store?.close();
    db.close();
    await rm(home, { recursive: true, force: true });
  }
});
