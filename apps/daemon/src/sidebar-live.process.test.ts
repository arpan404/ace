import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { Thread, ThreadId, type ThreadListEntry, type WorkspaceId } from "@ace/protocol";
import { Store } from "./store.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Small seeded generator, so a failing interleaving replays exactly. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(values: readonly T[]): T => {
    const index = Math.floor(next() * values.length);
    if (index >= values.length) throw new Error("Empty choice");
    return values[index] as T;
  };
  return { next, pick, chance: (p: number) => next() < p };
}

function open() {
  const dir = mkdtempSync(join(tmpdir(), "ace-sidebar-live-"));
  const path = join(dir, "events.sqlite");
  const db = new DatabaseSync(path);
  const store = new Store(path, () => {}, { database: db });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => store.close());
  const workspaces = ["a", "b", "c"].map((name) => {
    const at = join(dir, name);
    return store.createWorkspace(at, name);
  });
  return { path, db, store, workspaces };
}

function attempt<T>(read: () => T): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.name : String(error) };
  }
}

const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value));

type Options = { limit: number; project?: string; archived?: boolean };

test("live sidebar windows match a fresh full read through random interleaved changes", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) runSeed(seed);
});

function runSeed(seed: number) {
  const { path, db, store, workspaces } = open();
  const rng = random(seed);
  const ids: ThreadId[] = [];
  let made = 0;
  // Few distinct times, so ties on the sort key are common and order falls to the id.
  const time = () => rng.pick([100, 200, 300, 400, 500]);
  const create = (workspaceId: WorkspaceId) => {
    const id = ThreadId.parse(`t-${seed}-${made++}`);
    ids.push(id);
    store.appendEvents(id, [
      {
        type: "thread.created",
        thread: Thread.parse({
          id,
          workspaceId,
          title: rng.chance(0.2) ? "New thread" : `Task ${made}`,
          provider: "codex",
          status: rng.pick([{ state: "new" }, { state: "done" }, { state: "working", agents: 1 }]),
          createdAt: 1,
          updatedAt: time(),
          ...(rng.chance(0.6) ? { activityAt: time(), settledAt: time() } : {}),
          ...(rng.chance(0.5) ? { hasSentMessage: true } : {}),
        }),
      },
    ]);
    return id;
  };
  for (let i = 0; i < 24; i++) create(rng.pick(workspaces));

  const setClient = (id: string, field: string, value: unknown) =>
    db
      .prepare(
        value === undefined
          ? `UPDATE threads SET client = json_remove(COALESCE(client, '{}'), '$.${field}') WHERE id = ?`
          : `UPDATE threads SET client = json_set(COALESCE(client, '{}'), '$.${field}', json(?)) WHERE id = ?`,
      )
      .run(...(value === undefined ? [id] : [json(value), id]));
  // One random change to one thread, written the way some daemon path writes it.
  // Rows whose stored status has no state: the settled rule is NULL for them, so they are
  // in neither the live list nor the paged one. Only direct SQL touches them.
  const stateless = new Set<string>();
  const change = (id: ThreadId, sqlOnly = false): boolean => {
    const kind = sqlOnly || stateless.has(id) ? 1 : rng.next();
    if (kind < 0.12) {
      store.appendEvents(id, [
        {
          type: "thread.client.updated",
          changes: rng.pick([
            { settledAt: time(), activityAt: time() },
            { settledAt: null },
            { pinned: true },
            { pinned: false },
            { settledReason: "manual" },
          ]),
        },
      ]);
      return true;
    }
    if (kind < 0.2) {
      store.appendEvents(id, [
        {
          type: "queue.updated",
          revision: 1,
          pendingCount: rng.pick([0, 1]),
          paused: rng.chance(0.7),
          reason: rng.pick(["manual", "limit", "snooze", "stopped", null] as const),
          resumeAt: rng.chance(0.8) ? null : 9000,
        },
      ]);
      return true;
    }
    const field = rng.pick([
      "pinned",
      "settledAt",
      "settledReason",
      "deletedAt",
      "hasSentMessage",
      "activityAt",
      "status",
      "title",
      "archived",
      "workspace",
      "updated",
    ] as const);
    switch (field) {
      case "pinned":
        setClient(id, "pinned", rng.pick([true, false, undefined]));
        break;
      case "settledAt":
        setClient(id, "settledAt", rng.chance(0.7) ? time() : undefined);
        break;
      case "settledReason":
        setClient(id, "settledReason", rng.pick(["manual", "inactivity", undefined]));
        break;
      case "deletedAt":
        setClient(id, "deletedAt", rng.chance(0.3) ? time() : undefined);
        break;
      case "hasSentMessage":
        setClient(id, "hasSentMessage", rng.pick([true, false, undefined]));
        break;
      case "activityAt":
        setClient(id, "activityAt", rng.chance(0.8) ? time() : undefined);
        break;
      case "status": {
        const status = rng.pick([
          { state: "new" },
          { state: "done" },
          { state: "failed" },
          { state: "working", agents: 1 },
          { state: "needs_you", interactions: 1 },
          ...(sqlOnly ? [] : [{}]),
        ]);
        db.prepare("UPDATE threads SET status = ? WHERE id = ?").run(JSON.stringify(status), id);
        if ("state" in status) stateless.delete(id);
        else stateless.add(id);
        break;
      }
      case "title":
        db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(
          rng.pick(["New thread", "Named"]),
          id,
        );
        break;
      case "archived":
        db.prepare("UPDATE threads SET archived_at = ? WHERE id = ?").run(
          rng.chance(0.5) ? time() : null,
          id,
        );
        break;
      case "workspace":
        db.prepare("UPDATE threads SET workspace_id = ? WHERE id = ?").run(
          rng.pick(workspaces),
          id,
        );
        break;
      case "updated":
        db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(time(), id);
        break;
    }
    return false;
  };

  const windows: Options[] = [
    { limit: 1 },
    { limit: 5 },
    { limit: 20 },
    { limit: 3, project: workspaces[0] ?? "" },
    { limit: 2, project: workspaces[1] ?? "" },
    { limit: 4, project: "missing" },
    { limit: 3, archived: true },
    { limit: 2, project: workspaces[2] ?? "", archived: true },
  ];
  const selected = windows.map(() => new Map<string, ThreadListEntry>());
  let checks = 0;
  let failed = 0;
  const check = (changed: ReadonlySet<string>, step: number) => {
    windows.forEach((options, index) => {
      const entries = selected[index];
      if (!entries) throw new Error("Missing window");
      const label = `seed ${seed}, step ${step}, window ${JSON.stringify(options)}`;
      const full = attempt(() => store.sidebarPage(options));
      const live = attempt(() => store.sidebarPage(options, undefined, { entries, changed }));
      // A row the window must show but cannot decode fails both reads alike.
      if (!full.ok || !live.ok) {
        expect(live.ok ? "read" : live.error, label).toBe(full.ok ? "read" : full.error);
        failed++;
        return;
      }
      expect(
        live.value.threads.map((entry) => entry.id),
        label,
      ).toEqual(full.value.threads.map((entry) => entry.id));
      expect(live.value.threads, label).toEqual(full.value.threads);
      expect(live.value.window, label).toEqual(full.value.window);
      entries.clear();
      for (const entry of live.value.threads) entries.set(entry.id, entry);
      checks++;
    });
  };
  check(new Set(), 0);

  /** Run writes that roll back; what the test knows about rows rolls back with them. */
  const rolledBack = (run: () => void) => {
    const known = new Set(stateless);
    run();
    stateless.clear();
    for (const id of known) stateless.add(id);
  };
  for (let step = 1; step <= 150; step++) {
    const changed = new Set<string>();
    const writes = 1 + Math.floor(rng.next() * 3);
    for (let w = 0; w < writes; w++) {
      const roll = rng.next();
      const id = rng.pick(ids);
      if (roll < 0.06) {
        changed.add(create(rng.pick(workspaces)));
      } else if (roll < 0.075) {
        // An id change, possible only with foreign keys off.
        const moved = ThreadId.parse(`t-${seed}-${made++}`);
        db.exec("PRAGMA foreign_keys=OFF");
        db.prepare("UPDATE threads SET id = ? WHERE id = ?").run(moved, id);
        db.exec("PRAGMA foreign_keys=ON");
        ids.splice(ids.indexOf(id), 1, moved);
        if (stateless.delete(id)) stateless.add(moved);
      } else if (roll < 0.09) {
        // A hard delete, made the way an external cleanup would.
        db.exec("PRAGMA foreign_keys=OFF");
        db.prepare("DELETE FROM threads WHERE id = ?").run(id);
        db.exec("PRAGMA foreign_keys=ON");
        ids.splice(ids.indexOf(id), 1);
      } else if (roll < 0.14) {
        // Rolled back in the store's transaction: its revision is handed out again later.
        rolledBack(() =>
          expect(() =>
            store.atomic(() => {
              change(id);
              change(rng.pick(ids));
              throw new Error("abort");
            }),
          ).toThrow("abort"),
        );
      } else if (roll < 0.17) {
        // Another module's own transaction on the shared connection, rolled back.
        rolledBack(() => {
          db.exec("BEGIN IMMEDIATE");
          change(id, true);
          db.exec("ROLLBACK");
        });
      } else if (roll < 0.21) {
        const other = new DatabaseSync(path);
        other.exec("PRAGMA busy_timeout=5000");
        other.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(time(), id);
        other
          .prepare(
            "UPDATE threads SET client = json_set(COALESCE(client, '{}'), '$.settledAt', ?) WHERE id = ?",
          )
          .run(time(), id);
        other.close();
      } else if (change(id) || rng.chance(0.5)) {
        // Event writes name their thread; direct writes sometimes do and sometimes don't.
        changed.add(id);
      }
    }
    if (rng.chance(0.1))
      // Read inside an open write: the uncommitted rows show, and are never kept.
      rolledBack(() =>
        expect(() =>
          store.atomic(() => {
            const id = rng.pick(ids);
            change(id);
            check(new Set([id]), step);
            throw new Error("abort");
          }),
        ).toThrow("abort"),
      );
    check(changed, step);
  }
  // Most windows compare full payloads; the rest prove both reads fail alike.
  expect(checks + failed).toBeGreaterThan(1000);
  expect(checks).toBeGreaterThan(failed);
}

test("a delete the removal log no longer holds still leaves the live window without that thread", () => {
  const { db, store, workspaces } = open();
  const workspaceId = workspaces[0];
  if (!workspaceId) throw new Error("No workspace");
  const ids = [0, 1, 2].map((index) => {
    const id = ThreadId.parse(`gone-${index}`);
    store.appendEvents(id, [
      {
        type: "thread.created",
        thread: Thread.parse({
          id,
          workspaceId,
          title: `Task ${index}`,
          provider: "codex",
          status: { state: "done" },
          createdAt: 1,
          updatedAt: 100 + index,
          activityAt: 100 + index,
          settledAt: 100 + index,
          hasSentMessage: true,
        }),
      },
    ]);
    return id;
  });
  const live = (previous: { threads: ThreadListEntry[] }) =>
    store.sidebarPage({ limit: 10 }, undefined, {
      entries: new Map(previous.threads.map((thread) => [thread.id, thread])),
      changed: new Set(ids),
    });
  const first = live(store.sidebarPage({ limit: 10 }));
  expect(first.threads.map((thread) => thread.id).toSorted()).toEqual([...ids].toSorted());
  store.deleteThread(ids[1] as ThreadId);
  // As if more deletes than the log keeps had happened since the last read.
  db.exec("DELETE FROM sidebar_thread_removals");
  const second = live(first);
  expect(second.threads.map((thread) => thread.id).toSorted()).toEqual([ids[0], ids[2]]);
});
