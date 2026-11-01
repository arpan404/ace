import { Thread, ThreadId, type StorageReason } from "@ace/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { DelegationJournal } from "../agent-control/journal.ts";
import { migrateEngine } from "../engine/migrations.ts";
import { QueueStore } from "../engine/queue-store.ts";
import type { Store } from "../store.ts";
import { treeProtections } from "./delegation-trees.ts";
import { StorageInventory } from "./inventory.ts";
import { loadProtectionFacts, storageProtections, type ProtectionOwner } from "./ownership.ts";
import { storageFixture } from "./test-support.ts";

// The storage protection rules exactly as they were before membership and facts were read in
// bulk (main at bb0bb3b12), one SQLite lookup per thread. Kept as the reference the bulk
// readers must agree with on a real database; never import this into the daemon.
const original = {
  hasTable(store: Store, name: string): boolean {
    return Boolean(
      store.statement("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
    );
  },
  storageTree(store: Store, id: ThreadId): ThreadId[] {
    if (!original.hasTable(store, "delegation_participants")) return [id];
    const root = store
      .statement("SELECT root_id FROM delegation_participants WHERE thread_id=?")
      .get(id)?.root_id;
    if (typeof root !== "string") return [id];
    const rows = store
      .statement("SELECT thread_id FROM delegation_participants WHERE root_id=?")
      .all(root);
    return [
      ...new Set([id, ThreadId.parse(root), ...rows.map((row) => ThreadId.parse(row.thread_id))]),
    ];
  },
  storageProtections(owner: ProtectionOwner, ids: readonly ThreadId[]): StorageReason[] {
    const { store, services } = owner;
    const hasTable = (name: string) => original.hasTable(store, name);
    const reasons = new Set<StorageReason>();
    const members = new Set(ids.flatMap((id) => original.storageTree(store, id)));
    for (const id of members) {
      const thread = store.getThread(id);
      if (!thread) continue;
      if (thread.pinned) reasons.add("pinned");
      if (!["done", "failed", "new"].includes(thread.status.state)) reasons.add("active_tree");
      if (services.engine) {
        if (services.engine.hasSession(id)) reasons.add("leased");
        if (Object.values(services.engine.liveWork(id)).some((count) => count > 0))
          reasons.add("active_tree");
      } else if (hasTable("engine_sessions")) reasons.add("owner_unavailable");
      if (services.workspaceActions?.hasOwnedWork(id) || services.browser?.hasActiveSession(id))
        reasons.add("active_tree");
      if (
        hasTable("intents") &&
        store
          .statement(`SELECT 1 FROM intents WHERE thread_id=?
      AND (status IN ('pending','queued','running') OR awaiting=1 OR uncertain=1) LIMIT 1`)
          .get(id)
      )
        reasons.add("pending_input");
      if (
        hasTable("engine_queue") &&
        store
          .statement(
            "SELECT 1 FROM engine_queue WHERE thread_id=? AND (continuation IS NOT NULL OR resume_at IS NOT NULL)",
          )
          .get(id)
      )
        reasons.add("pending_input");
      if (
        hasTable("delegated_threads") &&
        store
          .statement(
            "SELECT 1 FROM delegated_threads WHERE (child_id=? OR parent_id=?) AND (phase<>'settled' OR result_pending=1) LIMIT 1",
          )
          .get(id, id)
      )
        reasons.add("active_tree");
      if (
        hasTable("delegation_reservations") &&
        store
          .statement(
            "SELECT 1 FROM delegation_reservations WHERE parent_id=? OR child_id=? LIMIT 1",
          )
          .get(id, id)
      )
        reasons.add("active_tree");
      if (
        hasTable("delegation_trees") &&
        store.statement("SELECT 1 FROM delegation_trees WHERE root_id=? AND active>0").get(id)
      )
        reasons.add("active_tree");
      if (
        store
          .statement("SELECT 1 FROM storage_cleanup_fences WHERE thread_id=? AND plan_id<>?")
          .get(id, owner.cleanupPlanId ?? "")
      )
        reasons.add("cleanup_in_progress");
      if (
        hasTable("engine_sessions") &&
        store
          .statement(
            "SELECT 1 FROM workspace_root_reservations r JOIN engine_sessions s ON s.cwd=r.root WHERE s.thread_id=? AND r.command_id<>?",
          )
          .get(id, `storage:${owner.cleanupPlanId ?? ""}`)
      )
        reasons.add("cleanup_in_progress");
    }
    return [...reasons];
  },
  /** The thread candidate's ownership fields, as StorageInventory.thread built them. */
  candidate(owner: ProtectionOwner, id: ThreadId) {
    const { store } = owner;
    const thread = store.getThread(id);
    if (!thread) return undefined;
    const members = original.storageTree(store, id);
    const protections = original.storageProtections(owner, members);
    if (thread.archivedAt === undefined && thread.deletedAt === undefined)
      protections.push("not_archived");
    if (
      members.some((member) => {
        const t = store.getThread(member);
        return t && t.archivedAt === undefined && t.deletedAt === undefined;
      })
    )
      protections.push("live_thread");
    const modifiedAt = Math.max(
      ...members.map((member) => {
        const t = member === id ? thread : store.getThread(member);
        if (!t || (member !== id && t.deletedAt !== undefined)) return 0;
        return Math.max(t.activityAt ?? t.updatedAt, t.archivedAt ?? 0, t.deletedAt ?? 0);
      }),
    );
    return { threadIds: members, protections: sorted(protections), modifiedAt };
  },
};

const sorted = (reasons: readonly StorageReason[]) => [...new Set(reasons)].toSorted();
const id = (value: string) => ThreadId.parse(value);

/** Live work the services report, switched per thread by a scenario. */
function liveServices() {
  const sessions = new Set<string>();
  const agents = new Set<string>();
  const owned = new Set<string>();
  const browsing = new Set<string>();
  const services: ProtectionOwner["services"] = {
    engine: {
      hasSession: (thread) => sessions.has(thread),
      liveWork: (thread) => ({ agentsRunning: agents.has(thread) ? 1 : 0, operationsRunning: 0 }),
    },
    workspaceActions: { hasOwnedWork: (thread) => owned.has(thread) },
    browser: { hasActiveSession: (thread) => browsing.has(thread) },
  };
  return { services, sessions, agents, owned, browsing };
}

const fixtures: Awaited<ReturnType<typeof storageFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

/** An archived thread that lives on another machine and serves a guest from a third. */
function remoteThread(f: Awaited<ReturnType<typeof storageFixture>>, sibling: ThreadId): ThreadId {
  const workspace = f.store.getThread(sibling)?.workspaceId;
  if (!workspace) throw new Error("fixture has no workspace");
  const thread = Thread.parse({
    id: "remote",
    workspaceId: workspace,
    title: "remote",
    provider: "codex",
    status: { state: "done" },
    createdAt: 1,
    updatedAt: 1,
    archivedAt: 1,
    details: {
      machine: { host: "other-mac.local", name: "Other Mac" },
      guest: { host: "third-mac.local", name: "Third Mac" },
    },
  });
  f.store.appendEvents(thread.id, [{ type: "thread.created", thread }], 1);
  return thread.id;
}

/**
 * Real engine, queue and delegation schemas with three trees: a root with children (one on
 * another machine, one deleted), an outer tree joined by an inner root that has its own leaf,
 * and a lone thread. Nothing is protected until a scenario adds one fact.
 */
async function world() {
  const f = await storageFixture();
  fixtures.push(f);
  f.store.atomic((db) => migrateEngine(db));
  // Constructing these creates the queue and delegation tables with their real schemas.
  const schemas = [new QueueStore(f.store), new DelegationJournal(f.store)];
  const make = (name: string) => f.thread(name).id;
  const root = make("root");
  const t = {
    root,
    a: make("a"),
    b: make("b"),
    remote: remoteThread(f, root),
    gone: make("gone"),
    outer: make("outer"),
    inner: make("inner"),
    leaf: make("leaf"),
    lone: make("lone"),
  };
  if (!f.store.getThread(t.remote)?.details?.machine)
    throw new Error("remote thread lost its machine");
  f.store.appendEvents(t.gone, [{ type: "thread.client.updated", changes: { deletedAt: 2 } }], 2);
  f.store.atomic((db) => {
    const tree = db.prepare("INSERT INTO delegation_trees(root_id,started_at) VALUES (?,1)");
    for (const treeRoot of [t.root, t.outer, t.inner]) tree.run(treeRoot);
    const member = db.prepare("INSERT INTO delegation_participants VALUES (?,?,0)");
    for (const child of [t.root, t.a, t.b, t.remote, t.gone]) member.run(child, t.root);
    member.run(t.outer, t.outer);
    member.run(t.inner, t.outer);
    member.run(t.leaf, t.inner);
    // Rows that never protect: settled, answered and empty facts, and other plans' own items.
    db.prepare("INSERT INTO delegated_threads VALUES (?,?,?,'settled-req','{}','settled',0,0)").run(
      t.b,
      t.root,
      t.root,
    );
    db.prepare("INSERT INTO engine_queue(thread_id) VALUES (?)").run(t.a);
    db.prepare(
      "INSERT INTO intents(command_id,thread_id,kind,payload,status) VALUES ('done-cmd',?,'thread.send','{}','done')",
    ).run(t.root);
  });
  const live = liveServices();
  const owner: ProtectionOwner = { store: f.store, services: live.services };
  return { f, t, live, owner, schemas, all: Object.values(t) };
}

/**
 * Every path the daemon uses agrees with the original rule for every thread: the removal-time
 * check, candidate inspection loaded from the thread alone, and one bulk read for a page.
 */
function expectOriginal(owner: ProtectionOwner, ids: readonly ThreadId[], page = ids) {
  const facts = loadProtectionFacts(owner, page);
  for (const thread of ids) {
    const tree = original.storageTree(owner.store, thread);
    const expected = sorted(original.storageProtections(owner, tree));
    expect(sorted(storageProtections(owner, [thread])), `removal check of ${thread}`).toEqual(
      sorted(original.storageProtections(owner, [thread])),
    );
    const alone = loadProtectionFacts(owner, [thread]);
    expect(alone.trees.tree(thread), `tree of ${thread}`).toEqual(tree);
    expect(
      sorted(treeProtections(alone.trees, alone.reasons, tree)),
      `inspection of ${thread}`,
    ).toEqual(expected);
    if (page.includes(thread))
      expect(
        sorted(treeProtections(facts.trees, facts.reasons, facts.trees.tree(thread), facts.memo)),
        `page read of ${thread}`,
      ).toEqual(expected);
  }
}

type World = Awaited<ReturnType<typeof world>>;
interface Fact {
  name: string;
  reason: StorageReason;
  apply(w: World, target: ThreadId): void;
}
const sql = (w: World, statement: string, ...values: (string | number)[]) =>
  w.f.store.atomic((db) => db.prepare(statement).run(...values));
const intent = (w: World, target: ThreadId, columns: string, values: string) =>
  sql(
    w,
    `INSERT INTO intents(command_id,thread_id,kind,payload,${columns}) VALUES (?,?,'thread.send','{}',${values})`,
    `cmd-${target}`,
    target,
  );
const facts: Fact[] = [
  {
    name: "pinned",
    reason: "pinned",
    apply: (w, target) =>
      w.f.store.appendEvents(
        target,
        [{ type: "thread.client.updated", changes: { pinned: true } }],
        3,
      ),
  },
  {
    name: "waiting on a human",
    reason: "active_tree",
    apply: (w, target) =>
      w.f.store.appendEvents(
        target,
        [{ type: "thread.updated", status: { state: "needs_you", interactions: 1 } }],
        3,
      ),
  },
  {
    name: "running",
    reason: "active_tree",
    apply: (w, target) =>
      w.f.store.appendEvents(
        target,
        [{ type: "thread.updated", status: { state: "working", agents: 1 } }],
        3,
      ),
  },
  {
    name: "waiting on a background task",
    reason: "active_tree",
    apply: (w, target) =>
      w.f.store.appendEvents(
        target,
        [{ type: "thread.updated", status: { state: "waiting", on: "background_task" } }],
        3,
      ),
  },
  { name: "engine session", reason: "leased", apply: (w, target) => w.live.sessions.add(target) },
  {
    name: "running agents",
    reason: "active_tree",
    apply: (w, target) => w.live.agents.add(target),
  },
  {
    name: "owned workspace work",
    reason: "active_tree",
    apply: (w, target) => w.live.owned.add(target),
  },
  {
    name: "active browser",
    reason: "active_tree",
    apply: (w, target) => w.live.browsing.add(target),
  },
  {
    name: "pending intent",
    reason: "pending_input",
    apply: (w, target) => intent(w, target, "status", "'pending'"),
  },
  {
    name: "running intent",
    reason: "pending_input",
    apply: (w, target) => intent(w, target, "status", "'running'"),
  },
  {
    name: "done intent awaiting an ack",
    reason: "pending_input",
    apply: (w, target) => intent(w, target, "status,awaiting", "'done',1"),
  },
  {
    name: "done intent with an uncertain delivery",
    reason: "pending_input",
    apply: (w, target) => intent(w, target, "status,uncertain", "'done',1"),
  },
  {
    name: "queue resume_at",
    reason: "pending_input",
    apply: (w, target) =>
      sql(
        w,
        "INSERT INTO engine_queue(thread_id,resume_at) VALUES (?,9) ON CONFLICT(thread_id) DO UPDATE SET resume_at=9",
        target,
      ),
  },
  {
    name: "queue continuation",
    reason: "pending_input",
    apply: (w, target) =>
      sql(
        w,
        "INSERT INTO engine_queue(thread_id,continuation) VALUES (?,'go') ON CONFLICT(thread_id) DO UPDATE SET continuation='go'",
        target,
      ),
  },
  {
    name: "unsettled delegation as the child",
    reason: "active_tree",
    apply: (w, target) =>
      sql(
        w,
        "INSERT OR REPLACE INTO delegated_threads VALUES (?,?,?,'req','{}','running',0,0)",
        target,
        w.t.lone === target ? w.t.root : w.t.lone,
        w.t.root,
      ),
  },
  {
    name: "unsettled delegation as the parent",
    reason: "active_tree",
    apply: (w, target) => {
      // A child thread outside every tree, so only the parent link can protect `target`.
      const child = w.f.thread(`child-of-${target}`).id;
      sql(
        w,
        "INSERT INTO delegated_threads VALUES (?,?,?,'req','{}','running',0,0)",
        child,
        target,
        w.t.root,
      );
    },
  },
  {
    name: "settled delegation with an unread result",
    reason: "active_tree",
    apply: (w, target) => {
      const child = w.f.thread(`result-of-${target}`).id;
      sql(
        w,
        "INSERT INTO delegated_threads VALUES (?,?,?,'req','{}','settled',1,0)",
        child,
        target,
        w.t.root,
      );
    },
  },
  {
    name: "delegation reservation as the parent",
    reason: "active_tree",
    apply: (w, target) =>
      sql(
        w,
        "INSERT INTO delegation_reservations VALUES ('reserved-child',?,?,'req','{}')",
        target,
        w.t.root,
      ),
  },
  {
    name: "delegation reservation as the child",
    reason: "active_tree",
    apply: (w, target) =>
      sql(
        w,
        "INSERT INTO delegation_reservations VALUES (?,'someone',?,'req','{}')",
        target,
        w.t.root,
      ),
  },
  {
    name: "active delegation tree",
    reason: "active_tree",
    apply: (w, target) =>
      sql(
        w,
        "INSERT INTO delegation_trees(root_id,started_at,active) VALUES (?,1,1) ON CONFLICT(root_id) DO UPDATE SET active=1",
        target,
      ),
  },
  {
    name: "another plan's cleanup fence",
    reason: "cleanup_in_progress",
    apply: (w, target) =>
      sql(w, "INSERT INTO storage_cleanup_fences VALUES (?,'other-plan')", target),
  },
  {
    name: "a workspace root reserved under the thread's session",
    reason: "cleanup_in_progress",
    apply: (w, target) => {
      sql(w, "INSERT INTO engine_sessions(thread_id,cwd) VALUES (?,?)", target, `/work/${target}`);
      sql(
        w,
        "INSERT INTO workspace_root_reservations VALUES (?,'someone','cmd-1')",
        `/work/${target}`,
      );
    },
  },
];
const targets = ["a", "remote", "gone", "root", "outer", "inner", "leaf", "lone"] as const;

describe("bulk protection reads match the original per-thread rule", () => {
  test("nothing in the base world is protected", async () => {
    const w = await world();
    for (const thread of w.all) expect(original.storageProtections(w.owner, [thread])).toEqual([]);
    expectOriginal(w.owner, w.all);
  });

  for (const fact of facts)
    test(`${fact.name} alone`, async () => {
      for (const name of targets) {
        const w = await world();
        fact.apply(w, w.t[name]);
        // The fact is live in the original rule, so its omission cannot pass unnoticed.
        expect(
          original.storageProtections(w.owner, [w.t[name]]),
          `${fact.name} on ${name}`,
        ).toEqual([fact.reason]);
        expectOriginal(w.owner, w.all);
      }
    });

  test("no engine with engine tables present keeps every existing thread", async () => {
    const w = await world();
    const owner: ProtectionOwner = { store: w.f.store, services: {} };
    expect(original.storageProtections(owner, [w.t.lone])).toEqual(["owner_unavailable"]);
    expectOriginal(owner, [...w.all, id("never-created")]);
  });

  test("a fence or root reservation held by this plan does not protect", async () => {
    const w = await world();
    sql(w, "INSERT INTO storage_cleanup_fences VALUES (?,'this-plan')", w.t.a);
    sql(w, "INSERT INTO engine_sessions(thread_id,cwd) VALUES (?,'/work/b')", w.t.b);
    sql(w, "INSERT INTO workspace_root_reservations VALUES ('/work/b','x','storage:this-plan')");
    const owner: ProtectionOwner = { ...w.owner, cleanupPlanId: "this-plan" };
    expect(original.storageProtections(owner, [w.t.a, w.t.b])).toEqual([]);
    expectOriginal(owner, w.all);
  });

  test("facts left behind by a purged thread with no row protect nothing", async () => {
    const w = await world();
    sql(w, "INSERT INTO storage_cleanup_fences VALUES ('purged','other-plan')");
    sql(
      w,
      "INSERT INTO delegation_reservations VALUES ('purged','also-purged',?,'req','{}')",
      w.t.root,
    );
    expect(original.storageProtections(w.owner, [id("purged")])).toEqual([]);
    expectOriginal(w.owner, [...w.all, id("purged")]);
  });
});

/** Hand-made tables without keys, as older layouts and earlier tests have them. */
async function lax(rows: readonly [string, string | null][], threads: readonly string[]) {
  const f = await storageFixture();
  fixtures.push(f);
  for (const name of threads) f.thread(name);
  f.store.atomic((db) => {
    db.exec(
      "CREATE TABLE delegation_participants(thread_id TEXT PRIMARY KEY,root_id TEXT); CREATE TABLE delegation_trees(root_id TEXT PRIMARY KEY,active INTEGER); CREATE TABLE engine_queue(thread_id TEXT,continuation TEXT,resume_at INTEGER)",
    );
    const insert = db.prepare("INSERT INTO delegation_participants VALUES (?,?)");
    for (const [thread, root] of rows) insert.run(thread, root);
  });
  const owner: ProtectionOwner = { store: f.store, services: liveServices().services };
  return {
    f,
    owner,
    ids: [...new Set([...threads, ...rows.flat()])].flatMap((x) => (x ? [id(x)] : [])),
  };
}
const queued = (store: Store, thread: string) =>
  store.atomic((db) => db.prepare("INSERT INTO engine_queue VALUES (?,NULL,5)").run(thread));

describe("membership shapes only older tables allow", () => {
  test("roots that name each other", async () => {
    const l = await lax(
      [
        ["x", "y"],
        ["y", "x"],
        ["z", "x"],
      ],
      ["x", "y", "z"],
    );
    queued(l.f.store, "z");
    expect(sorted(original.storageProtections(l.owner, [id("y")]))).toEqual(["pending_input"]);
    expectOriginal(l.owner, l.ids);
  });

  test("a root with no thread row", async () => {
    const l = await lax(
      [
        ["p", "ghost"],
        ["q", "ghost"],
      ],
      ["p", "q"],
    );
    queued(l.f.store, "q");
    expectOriginal(l.owner, [...l.ids, id("ghost")]);
  });

  test("a NULL root leaves its thread alone", async () => {
    const l = await lax(
      [
        ["solo", null],
        ["m", "n"],
        ["n", "n"],
      ],
      ["solo", "m", "n"],
    );
    queued(l.f.store, "n");
    queued(l.f.store, "solo");
    expectOriginal(l.owner, l.ids);
  });

  test("empty queue predicates protect nothing", async () => {
    const l = await lax(
      [
        ["m", "n"],
        ["n", "n"],
      ],
      ["m", "n"],
    );
    l.f.store.atomic((db) => db.prepare("INSERT INTO engine_queue VALUES ('m',NULL,NULL)").run());
    expect(original.storageProtections(l.owner, [id("m")])).toEqual([]);
    expectOriginal(l.owner, l.ids);
  });
});

const update = (
  store: Store,
  thread: ThreadId,
  changes: Partial<Pick<Thread, "activityAt" | "deletedAt">>,
  at: number,
) => store.appendEvents(thread, [{ type: "thread.client.updated", changes }], at);

/** One archived tree; `archived` gives a member's archive time, undefined for open. */
async function archivedTree(
  size: number,
  archived: (index: number) => number | undefined = () => 1,
) {
  const f = await storageFixture();
  fixtures.push(f);
  const journal = new DelegationJournal(f.store);
  const ids = Array.from(
    { length: size },
    (_, index) => f.thread(`m${index}`, { state: "done" }, { archivedAt: archived(index) }).id,
  );
  const [root] = ids;
  if (!root) throw new Error("empty tree");
  f.store.atomic((db) => {
    db.prepare("INSERT INTO delegation_trees(root_id,started_at) VALUES (?,1)").run(root);
    const insert = db.prepare("INSERT INTO delegation_participants VALUES (?,?,0)");
    for (const member of ids) insert.run(member, root);
  });
  const inventory = new StorageInventory({
    root: f.root,
    store: f.store,
    services: f.services,
    now: f.now,
    id: () => "inspect",
  });
  const owner: ProtectionOwner = { store: f.store, services: {} };
  return { f, ids, inventory, owner, journal };
}

describe("thread candidates match the original inspection", () => {
  test("live, recent and deleted members shape every candidate as before", async () => {
    const t = await archivedTree(6, (index) => (index === 1 ? undefined : 1));
    const [, live, recent, gone, older] = t.ids;
    if (!live || !recent || !gone || !older) throw new Error("short tree");
    update(t.f.store, recent, { activityAt: 50 * 86400000 }, 6);
    update(t.f.store, gone, { deletedAt: 150 * 86400000 }, 7);
    update(t.f.store, older, { activityAt: 9 }, 8);
    const page = await t.inventory.scan(new Set(["threads"]));
    for (const thread of t.ids) {
      const expected = original.candidate(t.owner, thread);
      const single = await t.inventory.thread(thread);
      const scanned = page.candidates.find((candidate) => candidate.label === thread);
      for (const actual of [single, scanned])
        expect(
          actual && {
            threadIds: actual.threadIds,
            protections: sorted(actual.protections),
            modifiedAt: actual.modifiedAt,
          },
          `candidate ${thread}`,
        ).toEqual(expected);
    }
    expect(original.candidate(t.owner, older)?.protections).toContain("live_thread");
  });

  test("a large tree is kept when its only busy member is outside the scanned page", async () => {
    // The busy member is archived last, so the scan's 256-thread page ends before it.
    const t = await archivedTree(300, (index) => (index === 299 ? 100 : 1));
    const busy = t.ids.at(-1);
    if (!busy) throw new Error("empty tree");
    t.f.store.atomic((db) =>
      db
        .prepare("INSERT INTO delegated_threads VALUES (?,?,?,'req','{}','running',0,0)")
        .run(busy, t.ids[0] ?? busy, t.ids[0] ?? busy),
    );
    const page = await t.inventory.scan(new Set(["threads"]));
    expect(page.complete).toBe(false);
    expect(page.candidates.some((candidate) => candidate.label === busy)).toBe(false);
    expect(page.candidates).toHaveLength(256);
    // The original rule costs a query per member per thread, so it checks a sample; every
    // page member shares one tree and must carry exactly the same protections.
    for (const sample of [t.ids[0], t.ids[128], t.ids[255]]) {
      if (!sample) throw new Error("short tree");
      expect(
        sorted(page.candidates.find((candidate) => candidate.label === sample)?.protections ?? []),
        `candidate ${sample}`,
      ).toEqual(original.candidate(t.owner, sample)?.protections);
    }
    for (const candidate of page.candidates)
      expect(sorted(candidate.protections), `candidate ${candidate.label}`).toEqual([
        "active_tree",
      ]);
  });
});
