// SPDX-License-Identifier: Apache-2.0

/**
 * What the two-process store cross gate shares with the tests it reuses (task 5.x-gate): the
 * seeded thread-stream driver that folds every step against the TypeScript projection, the
 * live-write helpers, the row-trust statement, and the read-only observer of a home on disk.
 *
 * The gate's child and the tests these came from call the same code, so a home crossing
 * backends is checked against exactly the reads those tests already prove. `Assertions` is the
 * one seam: Vitest in a test, `node:assert` in a child.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
// The process's own SQLite library (ADR 0222): with `ACE_STORE=native` the addon serves reads
// too, so two libraries never hold one file's WAL locks.
import { DatabaseSync } from "@ace/provider-kit/sqlite";
// The recovery copy is read by node:sqlite whatever the store runs on, so the two independent
// halves of the crossing are checked by independent SQLite libraries.
import { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import {
  Agent,
  AgentId,
  EventPayload,
  Item,
  ItemId,
  Thread,
  ThreadId,
  type Event,
  type ThreadListEntry,
  type WorkspaceId,
} from "@ace/protocol";
import { updateThread } from "@ace/projection";
import { Store } from "./store.ts";
import { capabilities } from "./thread-column-samples.ts";

export interface Assertions {
  /** `expect(a, label).toEqual(b)` in vitest; deep-equal after a JSON round trip in a child. */
  equal(actual: unknown, expected: unknown, label: string): void;
  /** `expect(a, label).toStrictEqual(b)`; `assert.deepStrictEqual` in a child. */
  strictEqual(actual: unknown, expected: unknown, label: string): void;
  /** `expect(run).toThrow(message)`; `assert.throws(run, { message })` in a child. */
  throws(run: () => unknown, message: string): void;
}

export interface StreamState {
  seed: number;
  ids: ThreadId[];
  items: Record<string, ItemId[]>;
  workspaces: WorkspaceId[];
}

export type Window = { limit: number; project?: string; archived?: boolean };

/** Threads and thread reads in id order, for the cache comparisons below. */
function byId(a: { id: string } | undefined, b: { id: string } | undefined): number {
  return (a?.id ?? "").localeCompare(b?.id ?? "");
}

/** Small seeded generator, so a failing sequence replays exactly. */
export function random(seed: number) {
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

/** A thread as JSON: what a client receives. */
export function persisted(thread: Thread | undefined): unknown {
  return thread && JSON.parse(JSON.stringify(thread));
}

/** Every thread, read fresh from its row, and the sidebar windows: what a client would see. */
export function snapshot(store: Store, windows: readonly Window[]) {
  return {
    threads: store.listThreads().toSorted((a, b) => a.id.localeCompare(b.id)),
    sidebar: windows.map((window) => store.sidebarPage(window)),
  };
}

export function withoutRevision({ threads, sidebar }: ReturnType<typeof snapshot>) {
  return {
    threads,
    sidebar: sidebar.map(({ window: { revision: _revision, ...window }, ...page }) => ({
      ...page,
      window,
    })),
  };
}

/** Creates `count` threads with root agents, as `runSeed` does, and returns the state. */
export function createThreads(store: Store, dir: string, seed: number, count: number): StreamState {
  const rng = random(seed);
  const workspaces: WorkspaceId[] = ["a", "b", "c"].map((name) =>
    store.createWorkspace(join(dir, name), name),
  );
  const time = () => rng.pick([100, 200, 300, 400, 500]);
  const ids: ThreadId[] = [];
  const items: Record<string, ItemId[]> = {};
  for (let n = 0; n < count; n++) {
    const id = ThreadId.parse(`thread-${seed}-${n}`);
    ids.push(id);
    items[id] = [];
    store.appendEvents(id, [
      {
        type: "thread.created",
        thread: Thread.parse({
          id,
          workspaceId: rng.pick(workspaces),
          title: rng.chance(0.2) ? "New thread" : `Task ${n}`,
          provider: rng.pick(["claude", "codex", "cursor"] as const),
          status: { state: "new" },
          createdAt: 1,
          updatedAt: time(),
          ...(rng.chance(0.7) ? { capabilities: capabilities(n) } : {}),
          ...(rng.chance(0.5) ? { details: { mode: "worktree", worktree: `/w/${n}` } } : {}),
          ...(rng.chance(0.3) ? { hasSentMessage: true, activityAt: time() } : {}),
        }),
      },
      {
        type: "agent.created",
        agent: Agent.parse({
          id: `root-${n}`,
          threadId: id,
          parentId: null,
          origin: "root",
          native: { provider: "codex" },
          fidelity: "full",
          cwd: "/repo",
          status: { state: "starting" },
          createdAt: 1,
        }),
      },
    ]);
  }
  return { seed, ids, items, workspaces };
}

/**
 * The stream `runSeed` replays: one event drawn roughly in the proportions a live daemon stores
 * them, a direct write, a rolled-back `atomic`, another module's own transaction, and the fold.
 * Every step ends in `check`. New item ids take `itemPrefix`, so a later process's items never
 * collide with an earlier one's.
 */
export function threadStream(
  store: Store,
  db: DatabaseSync,
  state: StreamState,
  assert: Assertions,
  itemPrefix = "",
): {
  windows: readonly Window[];
  /** Runs one step of `runSeed`'s loop, then `check`. */
  step(label: string): void;
  check(label: string, changed: ReadonlySet<string>): void;
} {
  const { seed, ids, items, workspaces } = state;
  const rng = random(seed);
  const time = () => rng.pick([100, 200, 300, 400, 500]);
  const root = (id: ThreadId) => AgentId.parse(`root-${ids.indexOf(id)}`);
  // Each thread as folded in memory from the events the store says it stored. Every thread the
  // home holds, not only the seeded ones: a home a later process reopened has boot threads too.
  const folded = new Map(store.listThreads().map((thread) => [thread.id, thread]));
  const fold = (id: ThreadId, payloads: EventPayload[]) => {
    const thread = folded.get(id);
    if (!thread) throw new Error("Missing thread");
    for (const event of store.appendEvents(id, payloads)) updateThread(thread, event);
  };

  /** One event, drawn roughly in the proportions a live daemon stores them. */
  const event = (id: ThreadId): EventPayload => {
    const roll = rng.next();
    const known = (items[id] ??= []);
    const message = (itemId: ItemId, complete: boolean) =>
      Item.parse({
        id: itemId,
        agentId: root(id),
        type: "message",
        role: "assistant",
        createdAt: 1,
        complete,
        parts: [{ type: "text", text: `${itemId} ${complete ? "done" : "so far"}` }],
      });
    if (roll < 0.25 && known.length)
      return {
        type: "item.delta",
        itemId: rng.pick(known),
        agentId: root(id),
        field: "text",
        append: " more",
      };
    if (roll < 0.4)
      return {
        type: "agent.status",
        agentId: root(id),
        status: rng.pick([
          { state: "working", activity: "thinking" },
          { state: "working", activity: "responding" },
          { state: "idle" },
        ] as const),
      };
    if (roll < 0.52 && known.length)
      return { type: "item.updated", item: message(rng.pick(known), rng.chance(0.5)) };
    if (roll < 0.6) {
      const itemId = ItemId.parse(`${itemPrefix}${id}-item-${known.length}`);
      known.push(itemId);
      return { type: "item.created", item: message(itemId, false) };
    }
    if (roll < 0.68)
      return {
        type: "context_meter.updated",
        meter: {
          agentId: root(id),
          epoch: 1,
          usedTokens: Math.floor(rng.next() * 100_000),
          windowTokens: 200_000,
          source: "provider",
        },
      };
    if (roll < 0.8)
      return {
        type: "thread.updated",
        ...rng.pick([
          { status: { state: "working", agents: 1 } },
          { status: { state: "done" } },
          { status: { state: "needs_you", interactions: 1 } },
          { title: rng.pick(["Renamed", "New thread", "Other"]) },
          { capabilities: capabilities(Math.floor(rng.next() * 4)) },
          { effectiveCapabilities: capabilities(Math.floor(rng.next() * 4)) },
          { archivedAt: rng.chance(0.5) ? time() : null },
          { queuedLaunch: rng.chance(0.5) ? { text: "later" } : null },
          { titleSource: "person" },
        ] as const),
      };
    if (roll < 0.92)
      return {
        type: "thread.client.updated",
        changes: rng.pick([
          { activityAt: time(), settledAt: time() },
          { settledAt: null },
          { pinned: rng.chance(0.5) },
          { hasSentMessage: true },
          { details: { mode: "worktree", worktree: `/w/${time()}`, ahead: 1 } },
          { details: { mode: "local" } },
          { live: { subagentCount: Math.floor(rng.next() * 3), waitingOn: 1 } },
          { live: {} },
        ]),
      };
    return {
      type: "queue.updated",
      revision: 1,
      pendingCount: rng.pick([0, 1]),
      paused: rng.chance(0.7),
      reason: rng.pick(["manual", "limit", "stopped", null] as const),
      resumeAt: rng.chance(0.8) ? null : 9000,
    };
  };

  /** A write some other daemon path makes straight to the tables. */
  const direct = (id: ThreadId) => {
    const kind = rng.pick(["client", "cold", "cold-delete", "cold-move", "status"] as const);
    if (kind === "client")
      db.prepare(
        "UPDATE threads SET client = json_set(COALESCE(client, '{}'), '$.readAt', ?) WHERE id = ?",
      ).run(time(), id);
    else if (kind === "cold")
      db.prepare(
        "INSERT INTO thread_cold (thread_id, details) VALUES (?, json(?)) ON CONFLICT(thread_id) DO UPDATE SET details = excluded.details",
      ).run(id, JSON.stringify({ mode: "local", branch: `b-${time()}` }));
    else if (kind === "cold-delete")
      db.prepare("DELETE FROM thread_cold WHERE thread_id = ?").run(id);
    else if (kind === "cold-move")
      // To a thread without a cold row; one that has a row keeps it.
      db.prepare("UPDATE OR IGNORE thread_cold SET thread_id = ? WHERE thread_id = ?").run(
        rng.pick(ids),
        id,
      );
    else
      db.prepare("UPDATE threads SET status = ? WHERE id = ?").run(
        JSON.stringify(rng.pick([{ state: "done" }, { state: "failed" }])),
        id,
      );
  };

  const windows: Window[] = [
    { limit: 3 },
    { limit: 20 },
    { limit: 2, project: workspaces[0] ?? "" },
    { limit: 5, archived: true },
  ];
  const live = windows.map(() => new Map<string, ThreadListEntry>());
  const check = (label: string, changed: ReadonlySet<string>) => {
    // A thread read through the cache matches the same row decoded fresh.
    const fresh = snapshot(store, windows);
    // And what was stored is what the events folded to.
    for (const thread of fresh.threads)
      assert.equal(persisted(thread), persisted(folded.get(thread.id)), label);
    const cached = fresh.threads.map((thread) => store.getThread(thread.id));
    assert.strictEqual(cached, fresh.threads, label);
    assert.strictEqual(
      fresh.threads.map((thread) => structuredClone(store.readThread(thread.id))),
      fresh.threads,
      label,
    );
    // The seeded threads on their own: a home that lost one must fail here, never vanish from
    // both sides of the comparison above.
    const seeded = new Set<string>(ids);
    const freshSeeded = fresh.threads.filter((thread) => seeded.has(thread.id));
    assert.strictEqual(freshSeeded.length, ids.length, `${label}, seeded threads`);
    assert.strictEqual(ids.map((id) => store.getThread(id)).toSorted(byId), freshSeeded, label);
    assert.strictEqual(
      ids.map((id) => structuredClone(store.readThread(id))).toSorted(byId),
      freshSeeded,
      label,
    );
    // Live sidebar windows, updated from changed rows, match a full read.
    windows.forEach((window, index) => {
      const entries = live[index];
      if (!entries) throw new Error("Missing window");
      const page = store.sidebarPage(window, undefined, { entries, changed });
      assert.equal(page, fresh.sidebar[index], `${label}, window ${index}`);
      entries.clear();
      for (const entry of page.threads) entries.set(entry.id, entry);
    });
  };

  const step = (label: string) => {
    const id = rng.pick(ids);
    const roll = rng.next();
    const changed = new Set<string>([id]);
    if (roll < 0.05) {
      direct(id);
      // A direct write is outside the events; a moved cold row changes a second thread.
      for (const thread of store.listThreads()) folded.set(thread.id, thread);
    } else if (roll < 0.09) {
      // Written, read inside the write, then rolled back: none of it may stay.
      const known = [...(items[id] ?? [])];
      assert.throws(
        () =>
          store.atomic(() => {
            store.appendEvents(id, [event(id), event(id)]);
            assert.strictEqual(
              store.getThread(id),
              store.listThreads().find((thread) => thread.id === id),
              label,
            );
            throw new Error("abort");
          }),
        "abort",
      );
      items[id] = known;
    } else if (roll < 0.12) {
      // Another module's own transaction on the shared connection, rolled back.
      db.exec("BEGIN IMMEDIATE");
      direct(id);
      db.exec("ROLLBACK");
    } else
      fold(
        id,
        Array.from({ length: 1 + Math.floor(rng.next() * 3) }, () => event(id)),
      );
    check(label, changed);
  };

  return { windows, step, check };
}

/** The pinned live write a test streams: no snapshot to commit. */
const unpinned = { persist() {}, committed() {} };

/** `prepareLiveWrite` + `bufferLiveWrite`, as the engine streams them: buffered, not stored. */
export function stream(store: Store, threadId: ThreadId, payloads: EventPayload[]): void {
  store.prepareLiveWrite(Buffer.byteLength(JSON.stringify(payloads)));
  store.bufferLiveWrite(threadId, payloads, 1000, unpinned);
}

/** The text `itemId`'s published deltas in `events` join to. */
export function answerText(events: Event[], itemId: string): string {
  return events
    .map((event) =>
      event.payload.type === "item.delta" && event.payload.itemId === itemId
        ? event.payload.append
        : "",
    )
    .join("");
}

/** The text `itemId` reads as now, through the snapshot a client opens with. */
export function snapshotText(store: Store, id: ThreadId, itemId: string): string {
  const item = store.snapshotThread(id).items[itemId];
  if (item?.type !== "message") throw new Error(`Missing ${itemId}`);
  return item.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** Rows the thread's current revision is confirmed at (`thread-row-trust`). */
export const confirmedSql =
  "SELECT COUNT(*) AS n FROM thread_row_trust AS trust JOIN sidebar_thread_revisions AS current ON current.thread_id = trust.thread_id AND current.revision = trust.revision";

/** A home's rows as `disk` and `diskCopy` read them, each in a fixed order. */
export type Disk = {
  events: { seq: number; id: string; thread_id: string; type: string; payload: string }[];
  hostSequence: number;
  recent: { workspace_id: string; opened_at: number }[];
  threads: Record<string, unknown>[];
  cold: Record<string, unknown>[];
  revisions: { thread_id: string; revision: number }[];
  stamps: Record<string, unknown>[];
  walBytes: number;
};

function readDisk(db: DatabaseSync, path: string): Disk {
  const all = (sql: string): Record<string, unknown>[] => db.prepare(sql).all();
  return {
    events: all("SELECT seq, id, thread_id, type, payload FROM events ORDER BY seq").map((row) => ({
      seq: Number(row["seq"]),
      id: String(row["id"]),
      thread_id: String(row["thread_id"]),
      type: String(row["type"]),
      payload: String(row["payload"]),
    })),
    hostSequence: Number(db.prepare("SELECT seq FROM host_sequence WHERE id = 1").get()?.["seq"]),
    recent: all("SELECT workspace_id, opened_at FROM workspace_recent ORDER BY workspace_id").map(
      (row) => ({
        workspace_id: String(row["workspace_id"]),
        opened_at: Number(row["opened_at"]),
      }),
    ),
    threads: all("SELECT * FROM threads ORDER BY id"),
    cold: all("SELECT * FROM thread_cold ORDER BY thread_id"),
    revisions: all(
      "SELECT thread_id, revision FROM sidebar_thread_revisions ORDER BY thread_id",
    ).map((row) => ({ thread_id: String(row["thread_id"]), revision: Number(row["revision"]) })),
    stamps: all("SELECT * FROM thread_row_trust ORDER BY thread_id"),
    walBytes: existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0,
  };
}

/**
 * A home's rows through its own read-only connection, the same observer in every mode. Use it
 * only while a `Store` holds the home: a reader then neither recovers nor checkpoints the WAL.
 * On a home nobody holds, a connection could recover and checkpoint the WAL, and the next
 * backend would never see the WAL it has to recover; `copyHome` and `diskCopy` are for that.
 */
export function disk(path: string): Disk {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return readDisk(db, path);
  } finally {
    db.close();
  }
}

/** Copies an unheld home's database and WAL (never its `-shm`) into a fresh `into`. */
export function copyHome(home: string, into: string): void {
  mkdirSync(into, { recursive: true });
  copyFileSync(join(home, "events.sqlite"), join(into, "events.sqlite"));
  const wal = join(home, "events.sqlite-wal");
  if (existsSync(wal)) copyFileSync(wal, join(into, "events.sqlite-wal"));
}

/**
 * Reads a `copyHome` copy writable, so SQLite recovers the copied WAL there, then deletes it.
 * The copy is the previous process's own file with its own WAL, so node:sqlite can recover it
 * even while the store runs on the addon: the reading library is deliberately not the store's,
 * so a recovery bug in the store's library cannot hide behind itself. (A live home is different:
 * `disk` must use the process's own library there.)
 */
export function diskCopy(into: string): Disk {
  const path = join(into, "events.sqlite");
  const db = new NodeDatabaseSync(path);
  try {
    return readDisk(db, path);
  } finally {
    db.close();
    rmSync(into, { recursive: true, force: true });
  }
}
