import { describe, expect, it } from "vitest";
import {
  projectSidebar,
  projectSidebarLease,
  projectThread,
  projectThreadLease,
  snapshotSidebar,
  snapshotThread,
  wrapSelection,
} from "./read-projection.ts";
import { sameIds } from "../selection.ts";

const noopCheck = () => {};

describe("read projection stability (useSyncExternalStore contract)", () => {
  it("wraps selections with a cached frozen snapshot", () => {
    let live = { a: 1, nested: { n: 1 } };
    const inner = {
      getSnapshot: () => live,
      subscribe: () => () => {},
    };
    const sel = wrapSelection(noopCheck, inner as never);
    const first = sel.getSnapshot() as unknown as typeof live;
    const second = sel.getSnapshot() as unknown as typeof live;
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.nested)).toBe(true);
    expect(first).toEqual({ a: 1, nested: { n: 1 } });

    // Mutating the snapshot cannot reach the live store (frozen).
    expect(() => {
      (first as unknown as Record<string, unknown>)["a"] = 99;
    }).toThrow();
    expect(live.a).toBe(1);

    // A new live reference produces a new frozen snapshot; the old one stays put.
    live = { a: 2, nested: { n: 2 } };
    const third = sel.getSnapshot() as unknown as typeof live;
    expect(third).not.toBe(first);
    expect(third).toEqual({ a: 2, nested: { n: 2 } });
    expect(first).toEqual({ a: 1, nested: { n: 1 } });
  });

  it("keeps projected store getters Object.is-stable while live is unchanged", () => {
    const liveIds = ["t1", "t2"];
    const liveRow = { id: "t1", title: "T" };
    const fakeLive = {
      error: undefined,
      syncing: false,
      unconfirmed: false,
      loaded: true,
      ids: liveIds,
      homeWindow: undefined,
      window: undefined,
      thread: () => liveRow,
      select: () => {
        throw new Error("unused");
      },
      observe: () => () => {},
    };
    const view = projectSidebar(noopCheck, fakeLive as never);
    expect(view.ids).toBe(view.ids);
    expect(view.thread("t1")).toBe(view.thread("t1"));
    expect(Object.isFrozen(view.ids)).toBe(true);

    // Interleaved ids stay stable per key: reading `b` must not evict `a`.
    const rows: Record<string, { id: string }> = {
      t1: { id: "t1" },
      t2: { id: "t2" },
    };
    const multiLive = {
      error: undefined,
      syncing: false,
      unconfirmed: false,
      loaded: true,
      ids: ["t1", "t2"],
      homeWindow: undefined,
      window: undefined,
      thread: (id: string) => rows[id],
      select: () => {
        throw new Error("unused");
      },
      observe: () => () => {},
    };
    const multi = projectSidebar(noopCheck, multiLive as never);
    const firstT1 = multi.thread("t1");
    multi.thread("t2");
    expect(multi.thread("t1")).toBe(firstT1);
    expect(multi.thread("t2")).toBe(multi.thread("t2"));

    // Live membership lists allocate per call (Object.keys); same contents stay stable.
    let members = ["a1"];
    const threadLive = {
      error: undefined,
      syncing: false,
      unconfirmed: false,
      thread: undefined,
      queue: undefined,
      offshift: undefined,
      context: undefined,
      order: [] as string[],
      cursor: 1,
      itemsBefore: null,
      agentIds: () => [...members],
      interactionIds: () => [] as string[],
      taskIds: () => [] as string[],
      item: () => undefined,
      agent: () => undefined,
      run: () => undefined,
      interaction: () => undefined,
      task: () => undefined,
      usage: () => undefined,
      contextMeter: () => undefined,
      usageSnapshot: () => undefined,
      truncated: () => false,
      children: () => [...members],
      select: () => {
        throw new Error("unused");
      },
      observe: () => () => {},
    };
    const tview = projectThread(noopCheck, threadLive as never);
    const firstAgents = tview.agentIds();
    // Second live call is a different array with equal contents.
    expect(threadLive.agentIds()).not.toBe(threadLive.agentIds());
    expect(tview.agentIds()).toBe(firstAgents);
    expect(sameIds(tview.children("a1"), tview.children("a1"))).toBe(true);
    expect(tview.children("a1")).toBe(tview.children("a1"));
    members = ["a1", "a2"];
    expect(tview.agentIds()).toEqual(["a1", "a2"]);
    expect(tview.agentIds()).not.toBe(firstAgents);
  });

  it("retains own __proto__ rows instead of dropping them", () => {
    const threads = {};
    Object.defineProperty(threads, "__proto__", {
      value: { id: "__proto__", title: "Proto" },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const live = {
      error: undefined,
      syncing: false,
      unconfirmed: false,
      loaded: true,
      ids: ["__proto__"],
      homeWindow: undefined,
      window: undefined,
      thread: (id: string) =>
        id === "__proto__" ? (threads as Record<string, unknown>)["__proto__"] : undefined,
      select: () => {
        throw new Error("unused");
      },
      observe: () => () => {},
    };
    const view = projectSidebar(noopCheck, live as never);
    // The row survives as an own property without polluting the prototype.
    expect(Object.hasOwn(view.thread("__proto__") as object, "id")).toBe(true);
    expect((view.thread("__proto__") as { title: string }).title).toBe("Proto");
    expect(Object.getPrototypeOf(view.thread("__proto__") as object)).not.toBe(
      (threads as Record<string, unknown>)["__proto__"],
    );
    const snap = snapshotSidebar(live as never);
    expect((snap.thread("__proto__") as { title: string }).title).toBe("Proto");
  });

  it("keeps appended optional, matching the live reader", () => {
    const base = {
      error: undefined,
      syncing: false,
      unconfirmed: false,
      thread: undefined,
      queue: undefined,
      offshift: undefined,
      context: undefined,
      order: [] as string[],
      cursor: 1,
      itemsBefore: null,
      agentIds: () => [] as string[],
      interactionIds: () => [] as string[],
      taskIds: () => [] as string[],
      item: () => undefined,
      agent: () => undefined,
      run: () => undefined,
      interaction: () => undefined,
      task: () => undefined,
      usage: () => undefined,
      contextMeter: () => undefined,
      usageSnapshot: () => undefined,
      truncated: () => false,
      select: () => {
        throw new Error("unused");
      },
      observe: () => () => {},
    };
    const without = projectThread(noopCheck, base as never);
    expect("appended" in without).toBe(false);
    expect(without.appended).toBeUndefined();
    expect(snapshotThread(base as never).appended).toBeUndefined();

    const itemA = { id: "a" };
    const itemB = { id: "b" };
    const withLive = { ...base, appended: () => true };
    const withView = projectThread(noopCheck, withLive as never);
    expect(typeof withView.appended).toBe("function");
    expect(withView.appended?.(itemA as never, itemB as never)).toBe(true);
    // Snapshots never retain the live closure: no leak past release, and no
    // dead WeakMap-identity fast-path on frozen copies. Callers fall back.
    const withSnap = snapshotThread(withLive as never);
    expect("appended" in withSnap).toBe(false);
    expect(withSnap.appended).toBeUndefined();
  });

  it("keeps per-id snapshots stable past the recency cap and drops them on lease release", async () => {
    const { RELEASE_PROJECTION_CACHES } = await import("./read-projection.ts");
    const rows: Record<string, { id: string }> = {};
    for (let i = 0; i < 600; i++) rows[`t${i}`] = { id: `t${i}` };
    const live = {
      error: undefined,
      syncing: false,
      unconfirmed: false,
      loaded: true,
      ids: Object.keys(rows),
      homeWindow: undefined,
      window: undefined,
      thread: (id: string) => rows[id],
      select: () => {
        throw new Error("unused");
      },
      observe: () => () => {},
    };
    const view = projectSidebar(noopCheck, live as never);
    // Regression: 472f77955's LRU-500 reminted an unchanged row once >500
    // keys interleaved, breaking `Object.is` stability for
    // `useSyncExternalStore`. The identity tier keeps the frozen copy while
    // the live row object is unchanged, regardless of interleave width.
    const first = view.thread("t0");
    for (let i = 1; i < 600; i++) view.thread(`t${i}`);
    expect(view.thread("t0")).toBe(first);
    // Round-robin twice more: recency churn must not remint either.
    for (let round = 0; round < 2; round++)
      for (let i = 0; i < 600; i++) expect(view.thread(`t${i}`)).toBe(view.thread(`t${i}`));
    expect(view.thread("t0")).toBe(first);

    // Change detection still works: a replaced live row mints a new copy.
    rows["t0"] = { id: "t0" };
    const second = view.thread("t0");
    expect(second).not.toBe(first);
    expect(view.thread("t0")).toBe(second);

    // Lease release clears every cache so live rows are not pinned past it.
    const inner = {
      store: live,
      release: () => {},
    };
    const lease = projectSidebarLease(noopCheck, inner as never);
    const leaseStore = lease.store;
    const held = leaseStore.thread("t1");
    expect(leaseStore.thread("t1")).toBe(held);
    lease.release();
    // Symbol access bypasses the pin-checked getters, so it stays readable
    // after release; the cached live rows themselves were dropped on release.
    const clearer = (leaseStore as unknown as Record<symbol, unknown>)[
      RELEASE_PROJECTION_CACHES as unknown as symbol
    ];
    // The store is dead after release; clearing ran without throwing.
    expect(() => leaseStore.thread("t1")).toThrow("not connected");
    expect(typeof clearer).toBe("function");
    // Caches are per-lease: a fresh lease over the same live store mints
    // its own copies instead of sharing the released lease's retention.
    const fresh = projectSidebarLease(noopCheck, inner as never);
    expect(fresh.store.thread("t1")).not.toBe(held);
    expect(fresh.store.thread("t1")).toBe(fresh.store.thread("t1"));
    fresh.release();
  });

  it("keeps thread item snapshots stable across wide interleaving", () => {
    const items: Record<string, { id: string }> = {};
    for (let i = 0; i < 600; i++) items[`m${i}`] = { id: `m${i}` };
    const live = {
      error: undefined,
      syncing: false,
      unconfirmed: false,
      thread: undefined,
      queue: undefined,
      offshift: undefined,
      context: undefined,
      order: Object.keys(items),
      cursor: 1,
      itemsBefore: null,
      agentIds: () => [] as string[],
      interactionIds: () => [] as string[],
      taskIds: () => [] as string[],
      item: (id: string) => items[id],
      agent: () => undefined,
      run: () => undefined,
      interaction: () => undefined,
      task: () => undefined,
      usage: () => undefined,
      contextMeter: () => undefined,
      usageSnapshot: () => undefined,
      truncated: () => false,
      select: () => {
        throw new Error("unused");
      },
      observe: () => () => {},
    };
    const view = projectThread(noopCheck, live as never);
    const first = view.item("m0");
    for (let i = 1; i < 600; i++) view.item(`m${i}`);
    // Unchanged live items survive >500-key interleaving without reminting.
    expect(view.item("m0")).toBe(first);
    for (let i = 0; i < 600; i++) view.item(`m${i}`);
    expect(view.item("m0")).toBe(first);
  });

  it("keeps allocating array copies content-stable and drops them on release", () => {
    let members = ["a1"];
    const live = {
      error: undefined,
      syncing: false,
      unconfirmed: false,
      thread: undefined,
      queue: undefined,
      offshift: undefined,
      context: undefined,
      order: [] as string[],
      cursor: 1,
      itemsBefore: null,
      agentIds: () => [...members],
      interactionIds: () => [] as string[],
      taskIds: () => [] as string[],
      item: () => undefined,
      agent: () => undefined,
      run: () => undefined,
      interaction: () => undefined,
      task: () => undefined,
      usage: () => undefined,
      contextMeter: () => undefined,
      usageSnapshot: () => undefined,
      truncated: () => false,
      children: (_agentId: string) => [...members],
      select: () => {
        throw new Error("unused");
      },
      observe: () => () => {},
    };
    const inner = { store: live, release: () => {} };
    const lease = projectThreadLease(noopCheck, inner as never);
    const store = lease.store;
    // The live getter allocates per call; equal contents stay Object.is-stable.
    expect(live.children("a1")).not.toBe(live.children("a1"));
    const first = store.children("a1");
    expect(store.children("a1")).toBe(first);
    // Changed contents mint a new frozen copy; the old one stays put.
    members = ["a1", "a2"];
    const second = store.children("a1");
    expect(second).not.toBe(first);
    expect(second).toEqual(["a1", "a2"]);
    expect(first).toEqual(["a1"]);
    expect(store.children("a1")).toBe(second);
    lease.release();
    expect(() => store.children("a1")).toThrow("not connected");
  });

  it("projected appended is false on frozen copies, live on store identities", async () => {
    const { ThreadStore, defaultLimits } = await import("@ace/client");
    const { Thread, Item, Event } = await import("@ace/protocol");
    const { createThreadView } = await import("@ace/projection");
    const thread = Thread.parse({
      id: "thread",
      workspaceId: "workspace",
      provider: "codex",
      title: "T",
      rootAgentId: "root",
      status: { state: "done" },
      createdAt: 0,
      updatedAt: 0,
    });
    const first = Item.parse({
      id: "m1",
      agentId: "root",
      type: "message",
      role: "assistant",
      createdAt: 1,
      complete: true,
      parts: [{ type: "text", text: "hello" }],
    });
    const store = new ThreadStore(defaultLimits);
    const view = createThreadView(thread, 10);
    view.items = { m1: first };
    view.itemOrder = ["m1"];
    view.itemSeqs = { m1: 10 };
    view.itemsBefore = null;
    store.snapshot(view);
    const deliver = (seq: number, payload: object) =>
      store.delivery({
        type: "events",
        subscriptionId: "s",
        afterSeq: seq - 1,
        throughSeq: seq,
        events: [Event.parse({ id: `e${seq}`, seq, at: seq, threadId: thread.id, payload })],
      });
    deliver(11, {
      type: "item.delta",
      itemId: "m1",
      agentId: "root",
      field: "text",
      append: " world",
    });
    const v1 = store.item("m1");
    deliver(12, { type: "item.delta", itemId: "m1", agentId: "root", field: "text", append: "!" });
    const v2 = store.item("m1");
    // Real SDK ground truth: successive appends share one prefix run.
    expect(store.appended(v1 as never, v2 as never)).toBe(true);

    const projected = projectThread(noopCheck, store as never);
    // Frozen view copies are never WeakMap identities → legally false.
    expect(projected.appended?.(projected.item("m1") as never, projected.item("m1") as never)).toBe(
      false,
    );
    // Snapshot omits the fast-path instead of leaking the live closure.
    expect(snapshotThread(store as never).appended).toBeUndefined();
  });

  it("filters exotic array entries instead of leaking undefined", () => {
    const liveMap = new Map([["k", 1]]);
    const fakeLive = {
      error: undefined,
      syncing: false,
      unconfirmed: false,
      thread: undefined,
      queue: undefined,
      offshift: undefined,
      context: undefined,
      order: ["i1", liveMap as unknown as string, "i2"],
      cursor: 1,
      itemsBefore: null,
      agentIds: () => ["a1", liveMap as unknown as string],
      interactionIds: () => [] as string[],
      taskIds: () => [] as string[],
      item: () => undefined,
      agent: () => undefined,
      run: () => undefined,
      interaction: () => undefined,
      task: () => undefined,
      usage: () => undefined,
      contextMeter: () => undefined,
      usageSnapshot: () => undefined,
      truncated: () => false,
      children: () => [] as string[],
      select: () => {
        throw new Error("unused");
      },
      observe: () => () => {},
    };
    const view = projectThread(noopCheck, fakeLive as never);
    // No `undefined` holes: exotic entries are dropped, element type holds.
    expect(view.order).toEqual(["i1", "i2"]);
    expect(view.order).not.toContain(undefined);
    expect(view.agentIds()).toEqual(["a1"]);
    expect(view.agentIds()).not.toContain(undefined);
    for (const id of view.order) expect(typeof id).toBe("string");
  });

  it("tears down a synchronously-notified inner subscription without leaking", () => {
    let innerStop = 0;
    let pinArmed = false;
    const inner = {
      getSnapshot: () => 1,
      subscribe: (listener: () => void) => {
        // The pin dies between the entry check and the synchronous notify.
        pinArmed = true;
        listener();
        return () => {
          innerStop += 1;
        };
      },
    };
    const check = () => {
      if (pinArmed) throw new Error("not connected");
    };
    const sel = wrapSelection(check, inner as never);
    const stop = sel.subscribe(() => {});
    // The synchronous notification saw the failed pin, detached everything,
    // and rolled back the fresh inner handle instead of resurrecting it.
    expect(innerStop).toBe(1);
    expect(() => stop()).not.toThrow();
    expect(() => sel.getSnapshot()).toThrow("not connected");
  });

  it("makes lease release idempotent when the inner release throws", () => {
    const fakeStore = {
      error: undefined,
      syncing: false,
      unconfirmed: false,
      loaded: true,
      ids: [] as string[],
      homeWindow: undefined,
      window: undefined,
      thread: () => undefined,
      select: () => {
        throw new Error("unused");
      },
      observe: () => () => {},
    };
    let releases = 0;
    const inner = {
      store: fakeStore,
      release: () => {
        releases += 1;
        throw new Error("inner boom");
      },
    };
    const lease = projectSidebarLease(noopCheck, inner as never);
    expect(lease.store.ids).toEqual([]);
    expect(() => lease.release()).not.toThrow();
    expect(releases).toBe(1);
    // Second release is a no-op: the throwing inner release is not retried.
    expect(() => lease.release()).not.toThrow();
    expect(releases).toBe(1);
    expect(() => lease.store).toThrow("not connected");
  });

  it("keeps static snapshots stable and point-in-time", () => {
    const live = {
      error: undefined,
      syncing: false,
      unconfirmed: false,
      loaded: true,
      ids: ["t1"],
      homeWindow: undefined,
      window: undefined,
      thread: (id: string) => (id === "t1" ? { id, title: "T" } : undefined),
      select: () => {
        throw new Error("unused");
      },
      observe: () => () => {},
    };
    const snap = snapshotSidebar(live as never);
    expect(snap.ids).toBe(snap.ids);
    expect(snap.thread("t1")).toBe(snap.thread("t1"));
    const sel = snap.select(["ids"], (sidebar) => sidebar.ids);
    expect(sel.getSnapshot()).toBe(sel.getSnapshot());

    const threadSnap = snapshotThread({
      error: undefined,
      syncing: false,
      unconfirmed: false,
      thread: { id: "th", title: "T" },
      queue: undefined,
      offshift: undefined,
      context: undefined,
      order: ["i1"],
      cursor: 1,
      itemsBefore: null,
      agentIds: () => ["a1"],
      interactionIds: () => [],
      taskIds: () => [],
      item: () => ({ id: "i1" }),
      agent: () => undefined,
      run: () => undefined,
      interaction: () => undefined,
      task: () => undefined,
      usage: () => undefined,
      contextMeter: () => undefined,
      usageSnapshot: () => undefined,
      truncated: () => false,
      select: () => {
        throw new Error("unused");
      },
      observe: () => () => {},
    } as never);
    const tsel = threadSnap.select(["order"], (reader) => reader.order);
    expect(tsel.getSnapshot()).toBe(tsel.getSnapshot());
  });
});
