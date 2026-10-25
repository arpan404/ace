import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import {
  Agent,
  AgentId,
  Capabilities,
  Item,
  ItemId,
  Thread,
  ThreadId,
  type EventPayload,
  type ThreadListEntry,
  type WorkspaceId,
} from "@ace/protocol";
import { updateThread } from "@ace/projection";
import { Store } from "./store.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Small seeded generator, so a failing sequence replays exactly. */
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

const capabilities = (variant: number) =>
  Capabilities.parse({
    steer: variant % 2 === 0,
    interruptCascades: true,
    resume: true,
    fork: variant % 3 === 0,
    subagentTranscripts: true,
    backgroundTaskControl: variant % 2 === 1,
    backgroundVisibility: "full",
    planMode: true,
    tokenUsage: true,
    imageInput: true,
    rewindFiles: false,
    permissionModes: Array.from({ length: 6 }, (_, n) => ({
      id: `mode-${n}`,
      label: `Mode ${n}`,
      description: `What mode ${n} lets the agent do without asking, variant ${variant}.`,
      risk: "medium",
    })),
  });

type Window = { limit: number; project?: string; archived?: boolean };

/** A thread as JSON: what a client receives. */
function persisted(thread: Thread | undefined): unknown {
  return thread && JSON.parse(JSON.stringify(thread));
}

function open(path: string) {
  const db = new DatabaseSync(path);
  const store = new Store(path, () => {}, { database: db });
  return { db, store };
}

/** Every thread, read fresh from its row, and the sidebar windows: what a client would see. */
function snapshot(store: Store, windows: readonly Window[]) {
  return {
    threads: store.listThreads().toSorted((a, b) => a.id.localeCompare(b.id)),
    sidebar: windows.map((window) => store.sidebarPage(window)),
  };
}

test("a status change is stored with its sequence, so a reloaded thread still reads as unread", () => {
  const dir = mkdtempSync(join(tmpdir(), "ace-activity-seq-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  let { store } = open(path);
  const id = ThreadId.parse("activity-thread");
  store.appendEvents(id, [
    {
      type: "thread.created",
      thread: Thread.parse({
        id,
        workspaceId: store.createWorkspace(dir, "Project"),
        title: "Task",
        provider: "codex",
        status: { state: "new" },
        createdAt: 1,
        updatedAt: 1,
        hasSentMessage: true,
      }),
    },
  ]);
  const [done] = store.appendEvents(id, [{ type: "thread.updated", status: { state: "done" } }]);
  if (!done) throw new Error("Missing event");
  // A device that read up to before this change compares its cursor with activitySeq.
  expect(store.getThread(id)?.activitySeq).toBe(done.seq);
  store.close();
  ({ store } = open(path));
  try {
    expect(store.getThread(id)?.activitySeq).toBe(done.seq);
    const entry = store.sidebarPage({ limit: 10 }).threads.find((thread) => thread.id === id);
    expect(entry?.activitySeq).toBe(done.seq);
  } finally {
    store.close();
  }
});

test("a long random event stream reads the same from cache, after a restart and after an upgrade", () => {
  for (const seed of [11, 12, 13]) runSeed(seed);
});

function runSeed(seed: number) {
  const dir = mkdtempSync(join(tmpdir(), "ace-thread-columns-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  let { db, store } = open(path);
  cleanups.push(() => {
    try {
      store.close();
    } catch {
      /* Closed by the test already. */
    }
  });
  const rng = random(seed);
  const workspaces: WorkspaceId[] = ["a", "b", "c"].map((name) =>
    store.createWorkspace(join(dir, name), name),
  );
  const time = () => rng.pick([100, 200, 300, 400, 500]);
  const ids: ThreadId[] = [];
  const items = new Map<string, ItemId[]>();
  for (let n = 0; n < 10; n++) {
    const id = ThreadId.parse(`thread-${seed}-${n}`);
    ids.push(id);
    items.set(id, []);
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
  const root = (id: ThreadId) => AgentId.parse(`root-${ids.indexOf(id)}`);
  // Each thread as folded in memory from the events the store says it stored.
  const folded = new Map(ids.map((id) => [id, store.getThread(id)]));
  const fold = (id: ThreadId, payloads: EventPayload[]) => {
    const thread = folded.get(id);
    if (!thread) throw new Error("Missing thread");
    for (const event of store.appendEvents(id, payloads)) updateThread(thread, event);
  };

  /** One event, drawn roughly in the proportions a live daemon stores them. */
  const event = (id: ThreadId): EventPayload => {
    const roll = rng.next();
    const known = items.get(id) ?? [];
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
      const itemId = ItemId.parse(`${id}-item-${known.length}`);
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
    const kind = rng.pick(["client", "cold", "status"] as const);
    if (kind === "client")
      db.prepare(
        "UPDATE threads SET client = json_set(COALESCE(client, '{}'), '$.readAt', ?) WHERE id = ?",
      ).run(time(), id);
    else if (kind === "cold")
      db.prepare(
        "INSERT INTO thread_cold (thread_id, details) VALUES (?, json(?)) ON CONFLICT(thread_id) DO UPDATE SET details = excluded.details",
      ).run(id, JSON.stringify({ mode: "local", branch: `b-${time()}` }));
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
      expect(persisted(thread), label).toEqual(persisted(folded.get(thread.id)));
    const cached = ids
      .map((id) => store.getThread(id))
      .toSorted((a, b) => (a?.id ?? "").localeCompare(b?.id ?? ""));
    expect(cached, label).toStrictEqual(fresh.threads);
    expect(
      ids
        .map((id) => structuredClone(store.readThread(id)))
        .toSorted((a, b) => (a?.id ?? "").localeCompare(b?.id ?? "")),
      label,
    ).toStrictEqual(fresh.threads);
    // Live sidebar windows, updated from changed rows, match a full read.
    windows.forEach((window, index) => {
      const entries = live[index];
      if (!entries) throw new Error("Missing window");
      const page = store.sidebarPage(window, undefined, { entries, changed });
      expect(page, `${label}, window ${index}`).toEqual(fresh.sidebar[index]);
      entries.clear();
      for (const entry of page.threads) entries.set(entry.id, entry);
    });
  };

  check(`seed ${seed}, start`, new Set());
  for (let step = 1; step <= 300; step++) {
    const id = rng.pick(ids);
    const label = `seed ${seed}, step ${step}`;
    const roll = rng.next();
    const changed = new Set<string>([id]);
    if (roll < 0.05) {
      direct(id);
      folded.set(
        id,
        store.listThreads().find((thread) => thread.id === id),
      );
    } else if (roll < 0.09) {
      // Written, read inside the write, then rolled back: none of it may stay.
      const known = [...(items.get(id) ?? [])];
      expect(() =>
        store.atomic(() => {
          store.appendEvents(id, [event(id), event(id)]);
          expect(store.getThread(id), label).toStrictEqual(
            store.listThreads().find((thread) => thread.id === id),
          );
          throw new Error("abort");
        }),
      ).toThrow("abort");
      items.set(id, known);
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
  }

  const before = snapshot(store, windows);
  const detailed = before.threads.filter((thread) => thread.details !== undefined).length;
  const capable = before.threads.filter((thread) => thread.capabilities !== undefined).length;
  expect(detailed).toBeGreaterThan(0);
  expect(capable).toBeGreaterThan(0);

  // A restart reads every thread and window back the same.
  store.close();
  ({ db, store } = open(path));
  expect(snapshot(store, windows), `seed ${seed}, restart`).toStrictEqual(before);
  for (const thread of before.threads) expect(store.getThread(thread.id)).toStrictEqual(thread);
  store.close();

  // A database from before thread_cold kept details in client and capabilities in
  // provider_metadata. Upgrading it moves them out and reads every thread the same.
  const old = new DatabaseSync(path);
  old.exec(`
    UPDATE threads SET client = json_set(COALESCE(client, '{}'), '$.details', json(cold.details))
      FROM thread_cold AS cold WHERE cold.thread_id = threads.id AND cold.details IS NOT NULL;
    UPDATE threads SET provider_metadata = json_set(COALESCE(provider_metadata, '{}'), '$.capabilities', json(cold.capabilities))
      FROM thread_cold AS cold WHERE cold.thread_id = threads.id AND cold.capabilities IS NOT NULL;
    DROP TRIGGER thread_cold_owner_delete;
    DROP TRIGGER thread_cold_owner_rekey;
    DROP TABLE thread_cold;
    UPDATE schema_version SET version = 16 WHERE id = 1;
  `);
  old.close();
  ({ db, store } = open(path));
  expect(snapshot(store, windows), `seed ${seed}, upgrade`).toStrictEqual(before);
  for (const thread of before.threads) expect(store.getThread(thread.id)).toStrictEqual(thread);
  const stored = db
    .prepare(
      "SELECT COUNT(*) AS n FROM threads WHERE json_type(client, '$.details') IS NOT NULL OR json_type(provider_metadata, '$.capabilities') IS NOT NULL",
    )
    .get();
  expect(stored?.n).toBe(0);
  const cold = db
    .prepare(
      "SELECT COUNT(details) AS details, COUNT(capabilities) AS capabilities FROM thread_cold",
    )
    .get();
  expect(cold).toEqual({ details: detailed, capabilities: capable });
  // And it keeps working: an event after the upgrade reads back the same both ways.
  const id = ids[0];
  if (!id) throw new Error("Missing thread");
  store.appendEvents(id, [{ type: "thread.client.updated", changes: { pinned: true } }]);
  expect(store.getThread(id)).toStrictEqual(store.listThreads().find((thread) => thread.id === id));
  expect(store.getThread(id)?.details).toStrictEqual(
    before.threads.find((thread) => thread.id === id)?.details,
  );
  store.close();
}
