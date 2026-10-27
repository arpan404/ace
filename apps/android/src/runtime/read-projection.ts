import { ClientError } from "@ace/client";
import type { Lease, Selection, SidebarSource, ThreadSource } from "@ace/client";

export type ReadCheck = () => void;

function notConnected(): Error {
  return new Error("This machine is not connected.");
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Read-projection copy policy.
 *
 * Real SDK read shapes are plain JSON-derived data (zod-inferred thread
 * rows, items, intents, string arrays, numbers, booleans). They never
 * contain Map/Set/Date/typed arrays, class instances, or functions, so the
 * copier below only reproduces JSON-like values (primitives, arrays, plain
 * objects) and drops anything else instead of returning a live reference.
 * Dropping is fail-safe: exotic values only appear in synthetic inputs, and
 * a snapshot must never hand out a mutable alias of the live store.
 *
 * `Object.freeze` does not stop `Map.set`, `Set.add`, or `Date.setTime`,
 * so copying those containers would hand out values that stay mutable
 * across reads; omitting them keeps every returned value truly immutable.
 */
const DROP: unique symbol = Symbol("dropReadValue");

function copyInner(value: unknown, seen: Map<object, unknown>): unknown {
  if (value === null || value === undefined) return value;
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean" || kind === "bigint")
    return value;
  if (kind !== "object") return DROP;
  const obj = value as unknown as object;
  const cached = seen.get(obj);
  if (cached !== undefined) return cached;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(obj, out);
    for (const entry of value) {
      const copied = copyInner(entry, seen);
      out.push(copied === DROP ? undefined : copied);
    }
    return Object.freeze(out);
  }
  if (!isPlainObject(obj)) return DROP;
  const out = Object.create(Object.getPrototypeOf(obj)) as Record<string | symbol, unknown>;
  seen.set(obj, out);
  for (const key of Reflect.ownKeys(obj) as (string | symbol)[]) {
    if (key === "__proto__") continue;
    let desc: PropertyDescriptor | undefined;
    try {
      desc = Object.getOwnPropertyDescriptor(obj, key);
    } catch {
      continue;
    }
    if (!desc || !desc.enumerable) continue;
    let raw: unknown;
    try {
      raw = (obj as Record<string | symbol, unknown>)[key];
    } catch {
      continue;
    }
    const copied = copyInner(raw, seen);
    if (copied === DROP) continue;
    try {
      Object.defineProperty(out, key, {
        value: copied,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    } catch {
      /* A key that cannot be defined stays absent rather than live. */
    }
  }
  return Object.freeze(out);
}

function freezeCopy<T>(value: T): T {
  const copied = copyInner(value, new Map());
  return (copied === DROP ? undefined : copied) as T;
}

function freezeError(error: ClientError | undefined): ClientError | undefined {
  if (error === undefined) return undefined;
  return Object.freeze(new ClientError(error.code, error.message));
}

function nullSealed<T extends object>(entries: Record<string | symbol, unknown>): T {
  const out = Object.create(null) as Record<string | symbol, unknown>;
  for (const [key, value] of Object.entries(entries)) out[key] = value;
  return Object.freeze(out) as T;
}

function copyTapKeys(keys: ReadonlySet<string> | "all"): ReadonlySet<string> | "all" {
  if (keys === "all") return "all";
  return Object.freeze(new Set(keys));
}

/** Teardown never throws: a failing release must not break `release()` callers. */
function teardown(fn: (() => void) | undefined): void {
  if (fn === undefined) return;
  try {
    fn();
  } catch {
    /* Release is best effort. */
  }
}

/**
 * One projected selection. A pin failure detaches every subscriber of the
 * wrapper (not just the notified one) so no stale inner subscription stays
 * registered on the live store; every teardown path is idempotent and never
 * throws. Listener exceptions are left to the live store, whose delivery
 * already isolates observers, so a throwing view cannot break bookkeeping.
 */
function shellSelection<T>(
  check: ReadCheck,
  inner: Selection<T>,
  track?: (release: () => void) => () => void,
): Selection<T> {
  let current: Selection<T> | undefined = inner;
  const actives = new Set<() => void>();
  const detachAll = (): void => {
    const pending = [...actives];
    actives.clear();
    current = undefined;
    for (const detach of pending) teardown(detach);
  };
  const out = Object.create(null) as {
    getSnapshot: () => T;
    subscribe: (listener: () => void) => () => void;
  };
  out.getSnapshot = () => {
    check();
    const live = current;
    if (live === undefined) throw notConnected();
    return freezeCopy(live.getSnapshot());
  };
  out.subscribe = (listener: () => void) => {
    check();
    const live = current;
    if (live === undefined) throw notConnected();
    let stopped = false;
    let unsub: (() => void) | undefined;
    let untrack: (() => void) | undefined;
    const detachOne = (): void => {
      if (stopped) return;
      stopped = true;
      actives.delete(detachOne);
      const stop = unsub;
      unsub = undefined;
      teardown(stop);
      const un = untrack;
      untrack = undefined;
      teardown(un);
    };
    actives.add(detachOne);
    let created: (() => void) | undefined;
    try {
      created = live.subscribe(() => {
        if (stopped) return;
        try {
          check();
        } catch {
          detachAll();
          return;
        }
        if (current === undefined || stopped) return;
        listener();
      });
    } catch (error) {
      actives.delete(detachOne);
      throw error;
    }
    unsub = created;
    if (track !== undefined) {
      try {
        untrack = track(detachOne);
      } catch (error) {
        detachOne();
        throw error;
      }
    }
    return () => {
      detachOne();
    };
  };
  return Object.freeze(out);
}

export function wrapSelection<T>(check: ReadCheck, inner: Selection<T>): Selection<T> {
  return shellSelection(check, inner);
}

function wrapTrackedSelection<T>(
  check: ReadCheck,
  inner: Selection<T>,
  track: (release: () => void) => () => void,
): Selection<T> {
  return shellSelection(check, inner, track);
}

/**
 * One projected `observe` tap. The key set is copied before delivery so a
 * consumer cannot mutate the live set; a throwing consumer cannot interrupt
 * delivery of committed facts. If `track` throws, the fresh inner tap is
 * rolled back instead of leaking on the live store.
 */
function observeShell(
  check: ReadCheck,
  subscribeLive: (tap: (keys: ReadonlySet<string> | "all") => void) => () => void,
  tap: (keys: ReadonlySet<string> | "all") => void,
  track?: (release: () => void) => () => void,
): () => void {
  check();
  let stopped = false;
  let unsub: (() => void) | undefined;
  let untrack: (() => void) | undefined;
  const detach = (): void => {
    if (stopped) return;
    stopped = true;
    const stop = unsub;
    unsub = undefined;
    teardown(stop);
    const un = untrack;
    untrack = undefined;
    teardown(un);
  };
  let created: (() => void) | undefined;
  created = subscribeLive((keys) => {
    if (stopped) return;
    try {
      check();
    } catch {
      detach();
      return;
    }
    let copied: ReadonlySet<string> | "all";
    try {
      copied = copyTapKeys(keys);
    } catch {
      return;
    }
    try {
      tap(copied);
    } catch {
      /* Consumer exceptions cannot interrupt delivery of committed facts. */
    }
  });
  unsub = created;
  if (track !== undefined) {
    try {
      untrack = track(detach);
    } catch (error) {
      detach();
      throw error;
    }
  }
  return () => {
    detach();
  };
}

export function projectSidebar(
  check: ReadCheck,
  live: SidebarSource,
  track?: (release: () => void) => () => void,
): SidebarSource {
  const view = Object.create(null) as Record<string, unknown>;
  const selectInner = (
    keys: readonly never[],
    read: (sidebar: SidebarSource) => unknown,
    equal?: (a: never, b: never) => boolean,
  ): Selection<unknown> => {
    check();
    const projected = view as unknown as SidebarSource;
    const inner = (live.select as (...args: unknown[]) => Selection<unknown>)(
      keys,
      () => read(projected),
      equal,
    );
    if (track === undefined) return wrapSelection(check, inner);
    return wrapTrackedSelection(check, inner, track);
  };
  const observeInner = (tap: (keys: ReadonlySet<string> | "all") => void): (() => void) =>
    observeShell(check, (forward) => live.observe(forward), tap, track);
  Object.defineProperties(view, {
    error: { enumerable: true, get: () => (check(), freezeError(live.error)) },
    syncing: { enumerable: true, get: () => (check(), live.syncing) },
    unconfirmed: { enumerable: true, get: () => (check(), live.unconfirmed) },
    loaded: { enumerable: true, get: () => (check(), live.loaded) },
    ids: { enumerable: true, get: () => (check(), freezeCopy(live.ids)) },
    homeWindow: { enumerable: true, get: () => (check(), freezeCopy(live.homeWindow)) },
    window: { enumerable: true, get: () => (check(), freezeCopy(live.window)) },
  });
  view["thread"] = (id: string) => {
    check();
    return freezeCopy(live.thread(id));
  };
  view["select"] = selectInner;
  view["observe"] = observeInner;
  return Object.freeze(view) as unknown as SidebarSource;
}

export function projectThread(
  check: ReadCheck,
  live: ThreadSource,
  track?: (release: () => void) => () => void,
): ThreadSource {
  const view = Object.create(null) as Record<string, unknown>;
  const selectInner = (
    keys: readonly never[],
    selector: (reader: unknown) => unknown,
    equal?: (a: never, b: never) => boolean,
  ): Selection<unknown> => {
    check();
    const projected = view as unknown as ThreadSource;
    const inner = (live.select as (...args: unknown[]) => Selection<unknown>)(
      keys,
      () => selector(projected),
      equal,
    );
    if (track === undefined) return wrapSelection(check, inner);
    return wrapTrackedSelection(check, inner, track);
  };
  const observeInner = (tap: (keys: ReadonlySet<string> | "all") => void): (() => void) =>
    observeShell(check, (forward) => live.observe(forward), tap, track);
  Object.defineProperties(view, {
    error: { enumerable: true, get: () => (check(), freezeError(live.error)) },
    syncing: { enumerable: true, get: () => (check(), live.syncing) },
    unconfirmed: { enumerable: true, get: () => (check(), live.unconfirmed) },
    thread: { enumerable: true, get: () => (check(), freezeCopy(live.thread)) },
    queue: { enumerable: true, get: () => (check(), freezeCopy(live.queue)) },
    offshift: { enumerable: true, get: () => (check(), freezeCopy(live.offshift)) },
    context: { enumerable: true, get: () => (check(), freezeCopy(live.context)) },
    order: { enumerable: true, get: () => (check(), freezeCopy(live.order)) },
    cursor: { enumerable: true, get: () => (check(), live.cursor) },
    itemsBefore: { enumerable: true, get: () => (check(), live.itemsBefore) },
  });
  view["agentIds"] = () => (check(), freezeCopy(live.agentIds()));
  view["children"] = (agentId: string) => (check(), freezeCopy(live.children(agentId)));
  view["interactionIds"] = () => (check(), freezeCopy(live.interactionIds()));
  view["taskIds"] = () => (check(), freezeCopy(live.taskIds()));
  view["item"] = (id: string) => (check(), freezeCopy(live.item(id)));
  view["agent"] = (id: string) => (check(), freezeCopy(live.agent(id)));
  view["run"] = (id: string) => (check(), freezeCopy(live.run(id)));
  view["interaction"] = (id: string) => (check(), freezeCopy(live.interaction(id)));
  view["task"] = (id: string) => (check(), freezeCopy(live.task(id)));
  view["usage"] = (id: string) => (check(), freezeCopy(live.usage(id)));
  view["contextMeter"] = (id: string) => (check(), freezeCopy(live.contextMeter(id)));
  view["usageSnapshot"] = (key: string) => (check(), freezeCopy(live.usageSnapshot(key)));
  view["truncated"] = (id: string) => (check(), live.truncated(id));
  if (typeof live.runIds === "function")
    view["runIds"] = () => (check(), freezeCopy(live.runIds?.()));
  if (typeof live.itemSeq === "function")
    view["itemSeq"] = (id: string) => (check(), live.itemSeq?.(id));
  if (typeof live.deleted === "function")
    view["deleted"] = (id: string) => (check(), live.deleted?.(id));
  if (typeof live.appended === "function")
    view["appended"] = (a: unknown, b: unknown) => (
      check(),
      (live.appended as (x: never, y: never) => boolean)(a as never, b as never)
    );
  view["select"] = selectInner;
  view["observe"] = observeInner;
  return Object.freeze(view) as unknown as ThreadSource;
}

function staticSelection<T>(read: () => T): Selection<T> {
  return nullSealed<Selection<T>>({
    getSnapshot: () => freezeCopy(read()),
    subscribe: () => () => {},
  });
}

export function snapshotSidebar(live: SidebarSource): SidebarSource {
  const ids = freezeCopy(live.ids);
  const rows = new Map<string, unknown>();
  for (const id of ids) rows.set(id, freezeCopy(live.thread(id)));
  const data = {
    error: freezeError(live.error),
    syncing: live.syncing,
    unconfirmed: live.unconfirmed,
    loaded: live.loaded,
    ids,
    homeWindow: freezeCopy(live.homeWindow),
    window: freezeCopy(live.window),
  };
  const snap = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(snap, {
    error: { enumerable: true, get: () => data.error },
    syncing: { enumerable: true, get: () => data.syncing },
    unconfirmed: { enumerable: true, get: () => data.unconfirmed },
    loaded: { enumerable: true, get: () => data.loaded },
    ids: { enumerable: true, get: () => data.ids },
    homeWindow: { enumerable: true, get: () => data.homeWindow },
    window: { enumerable: true, get: () => data.window },
  });
  snap["thread"] = (id: string) => rows.get(id) as unknown;
  snap["select"] = (
    _keys: readonly unknown[],
    read: (sidebar: SidebarSource) => unknown,
  ): Selection<unknown> => staticSelection(() => read(snap as unknown as SidebarSource));
  snap["observe"] = (): (() => void) => () => {};
  return Object.freeze(snap) as unknown as SidebarSource;
}

type ThreadExportView = {
  thread?: unknown;
  queue?: unknown;
  offshift?: unknown;
  contextMeters?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  agentChildren?: Record<string, readonly string[]>;
  runs?: Record<string, unknown>;
  items?: Record<string, unknown>;
  itemOrder?: readonly string[];
  itemSeqs?: Record<string, number>;
  itemsBefore?: number | null;
  entitiesBefore?: unknown;
  interactions?: Record<string, unknown>;
  backgroundTasks?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  usageSnapshots?: Record<string, unknown>;
  seq?: number;
};

type ThreadExportLike = {
  syncing?: boolean;
  unconfirmed?: boolean;
  error?: { code: ClientError["code"]; message: string } | undefined;
  view?: ThreadExportView | undefined;
  truncated?: readonly string[];
  deleted?: readonly string[];
};

export function snapshotThread(live: ThreadSource): ThreadSource {
  const exported = (live as unknown as { export?: () => ThreadExportLike }).export?.() as
    | ThreadExportLike
    | undefined;
  if (exported?.view) {
    const view = exported.view;
    const rootId = (view.thread as { rootAgentId?: string } | undefined)?.rootAgentId;
    const context =
      rootId !== undefined && view.contextMeters && Object.hasOwn(view.contextMeters, rootId)
        ? view.contextMeters[rootId]
        : undefined;
    const data: Record<string, unknown> = {
      error:
        exported.error === undefined
          ? freezeError(live.error)
          : freezeError(new ClientError(exported.error.code, exported.error.message)),
      syncing: exported.syncing ?? live.syncing,
      unconfirmed: exported.unconfirmed ?? live.unconfirmed,
      thread: freezeCopy(view.thread),
      queue: freezeCopy(view.queue),
      offshift: freezeCopy(view.offshift),
      context: freezeCopy(context),
      order: freezeCopy(view.itemOrder ?? []),
      cursor: view.seq,
      itemsBefore: view.itemsBefore ?? null,
      agentIds: freezeCopy(Object.keys(view.agents ?? {})),
      runIds: freezeCopy(Object.keys(view.runs ?? {})),
      interactionIds: freezeCopy(Object.keys(view.interactions ?? {})),
      taskIds: freezeCopy(Object.keys(view.backgroundTasks ?? {})),
    };
    const items = new Map<string, unknown>();
    for (const [id, entry] of Object.entries(view.items ?? {})) items.set(id, freezeCopy(entry));
    const agents = new Map<string, unknown>();
    for (const [id, entry] of Object.entries(view.agents ?? {})) agents.set(id, freezeCopy(entry));
    const runs = new Map<string, unknown>();
    for (const [id, entry] of Object.entries(view.runs ?? {})) runs.set(id, freezeCopy(entry));
    const interactions = new Map<string, unknown>();
    for (const [id, entry] of Object.entries(view.interactions ?? {}))
      interactions.set(id, freezeCopy(entry));
    const tasks = new Map<string, unknown>();
    for (const [id, entry] of Object.entries(view.backgroundTasks ?? {}))
      tasks.set(id, freezeCopy(entry));
    const usage = new Map<string, unknown>();
    for (const [id, entry] of Object.entries(view.usage ?? {})) usage.set(id, freezeCopy(entry));
    const meters = new Map<string, unknown>();
    for (const [id, entry] of Object.entries(view.contextMeters ?? {}))
      meters.set(id, freezeCopy(entry));
    const usageSnapshots = new Map<string, unknown>();
    for (const [key, entry] of Object.entries(view.usageSnapshots ?? {}))
      usageSnapshots.set(key, freezeCopy(entry));
    const children = new Map<string, unknown>();
    for (const [id, entry] of Object.entries(view.agentChildren ?? {}))
      children.set(id, freezeCopy(entry));
    const seqs = new Map<string, number>();
    for (const [id, seq] of Object.entries(view.itemSeqs ?? {})) seqs.set(id, seq);
    const truncated = new Set<string>(exported.truncated ?? []);
    const deleted = new Set<string>(exported.deleted ?? []);
    return buildThreadSnapshot({
      data,
      items,
      agents,
      runs,
      interactions,
      tasks,
      usage,
      meters,
      usageSnapshots,
      children,
      seqs,
      truncated,
      deleted,
    });
  }
  const order = [...live.order];
  const agentIds = [...live.agentIds()];
  const runIds = typeof live.runIds === "function" ? [...(live.runIds() ?? [])] : undefined;
  const interactionIds = [...live.interactionIds()];
  const taskIds = [...live.taskIds()];
  const thread = freezeCopy(live.thread);
  const queue = freezeCopy(live.queue);
  const offshift = freezeCopy(live.offshift);
  const context = freezeCopy(live.context);
  const data: Record<string, unknown> = {
    error: freezeError(live.error),
    syncing: live.syncing,
    unconfirmed: live.unconfirmed,
    thread,
    queue,
    offshift,
    context,
    order: freezeCopy(order),
    cursor: live.cursor,
    itemsBefore: live.itemsBefore,
    agentIds: freezeCopy(agentIds),
    runIds: runIds === undefined ? undefined : freezeCopy(runIds),
    interactionIds: freezeCopy(interactionIds),
    taskIds: freezeCopy(taskIds),
  };
  const items = new Map<string, unknown>();
  for (const id of order) items.set(id, freezeCopy(live.item(id)));
  const agents = new Map<string, unknown>();
  for (const id of agentIds) agents.set(id, freezeCopy(live.agent(id)));
  const runs = new Map<string, unknown>();
  if (runIds !== undefined && typeof live.run === "function")
    for (const id of runIds) runs.set(id, freezeCopy(live.run(id)));
  const interactions = new Map<string, unknown>();
  for (const id of interactionIds) interactions.set(id, freezeCopy(live.interaction(id)));
  const tasks = new Map<string, unknown>();
  for (const id of taskIds) tasks.set(id, freezeCopy(live.task(id)));
  const usage = new Map<string, unknown>();
  if (typeof live.usage === "function")
    for (const id of agentIds) {
      const entry = live.usage(id);
      if (entry !== undefined) usage.set(id, freezeCopy(entry));
    }
  const meters = new Map<string, unknown>();
  if (typeof live.contextMeter === "function")
    for (const id of agentIds) {
      const entry = live.contextMeter(id);
      if (entry !== undefined) meters.set(id, freezeCopy(entry));
    }
  const usageSnapshots = new Map<string, unknown>();
  const children = new Map<string, unknown>();
  if (typeof live.children === "function")
    for (const id of agentIds) children.set(id, freezeCopy(live.children(id)));
  const seqs = new Map<string, number>();
  if (typeof live.itemSeq === "function")
    for (const id of order) {
      const seq = live.itemSeq(id);
      if (seq !== undefined) seqs.set(id, seq);
    }
  const truncated = new Set<string>();
  if (typeof live.truncated === "function")
    for (const id of order) {
      try {
        if (live.truncated(id)) truncated.add(id);
      } catch {
        /* A failing read leaves the snapshot without that flag. */
      }
    }
  const deleted = new Set<string>();
  if (typeof live.deleted === "function") {
    for (const id of order) {
      try {
        if (live.deleted(id)) deleted.add(id);
      } catch {
        /* A failing read leaves the snapshot without that flag. */
      }
    }
    if (typeof live.item === "function") {
      for (const [id] of agents) {
        try {
          if (live.deleted(id) && !deleted.has(id)) deleted.add(id);
        } catch {
          /* Best effort. */
        }
      }
    }
  }
  return buildThreadSnapshot({
    data,
    items,
    agents,
    runs,
    interactions,
    tasks,
    usage,
    meters,
    usageSnapshots,
    children,
    seqs,
    truncated,
    deleted,
  });
}

function buildThreadSnapshot(parts: {
  data: Record<string, unknown>;
  items: Map<string, unknown>;
  agents: Map<string, unknown>;
  runs: Map<string, unknown>;
  interactions: Map<string, unknown>;
  tasks: Map<string, unknown>;
  usage: Map<string, unknown>;
  meters: Map<string, unknown>;
  usageSnapshots: Map<string, unknown>;
  children: Map<string, unknown>;
  seqs: Map<string, number>;
  truncated: Set<string>;
  deleted: Set<string>;
}): ThreadSource {
  const { data, items, agents, runs, interactions, tasks, usage, meters, usageSnapshots } = parts;
  const { children, seqs, truncated, deleted } = parts;
  const snap = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(snap, {
    error: { enumerable: true, get: () => data["error"] },
    syncing: { enumerable: true, get: () => data["syncing"] },
    unconfirmed: { enumerable: true, get: () => data["unconfirmed"] },
    thread: { enumerable: true, get: () => data["thread"] },
    queue: { enumerable: true, get: () => data["queue"] },
    offshift: { enumerable: true, get: () => data["offshift"] },
    context: { enumerable: true, get: () => data["context"] },
    order: { enumerable: true, get: () => data["order"] },
    cursor: { enumerable: true, get: () => data["cursor"] },
    itemsBefore: { enumerable: true, get: () => data["itemsBefore"] },
  });
  snap["agentIds"] = () => data["agentIds"] as readonly string[];
  if (data["runIds"] !== undefined) snap["runIds"] = () => data["runIds"] as readonly string[];
  snap["children"] = (agentId: string) => (children.get(agentId) ?? []) as unknown;
  snap["interactionIds"] = () => data["interactionIds"] as readonly string[];
  snap["taskIds"] = () => data["taskIds"] as readonly string[];
  snap["item"] = (id: string) => items.get(id) as unknown;
  snap["agent"] = (id: string) => agents.get(id) as unknown;
  snap["run"] = (id: string) => runs.get(id) as unknown;
  snap["interaction"] = (id: string) => interactions.get(id) as unknown;
  snap["task"] = (id: string) => tasks.get(id) as unknown;
  snap["usage"] = (id: string) => usage.get(id) as unknown;
  snap["contextMeter"] = (id: string) => meters.get(id) as unknown;
  snap["usageSnapshot"] = (key: string) => usageSnapshots.get(key) as unknown;
  snap["truncated"] = (id: string) => truncated.has(id);
  snap["itemSeq"] = (id: string) => seqs.get(id) as unknown;
  snap["deleted"] = (id: string) => deleted.has(id);
  snap["appended"] = () => false;
  snap["select"] = (
    _keys: readonly unknown[],
    selector: (reader: unknown) => unknown,
  ): Selection<unknown> => staticSelection(() => selector(snap as unknown as ThreadSource));
  snap["observe"] = (): (() => void) => () => {};
  return Object.freeze(snap) as unknown as ThreadSource;
}

export function projectSidebarLease(
  check: ReadCheck,
  inner: Lease<SidebarSource>,
): Lease<SidebarSource> {
  let released = false;
  const active = new Set<() => void>();
  const track = (release: () => void): (() => void) => {
    active.add(release);
    return () => {
      active.delete(release);
    };
  };
  const guarded: ReadCheck = () => {
    if (released) throw notConnected();
    check();
  };
  const store = projectSidebar(guarded, inner.store, track);
  const out = Object.create(null) as { store: SidebarSource; release: () => void };
  Object.defineProperty(out, "store", { enumerable: true, get: () => (guarded(), store) });
  out.release = () => {
    if (released) return;
    released = true;
    for (const release of active) {
      try {
        release();
      } catch {
        /* Release is best effort. */
      }
    }
    active.clear();
    inner.release();
  };
  return Object.freeze(out);
}

export function projectThreadLease(
  check: ReadCheck,
  inner: Lease<ThreadSource>,
): Lease<ThreadSource> {
  let released = false;
  const active = new Set<() => void>();
  const track = (release: () => void): (() => void) => {
    active.add(release);
    return () => {
      active.delete(release);
    };
  };
  const guarded: ReadCheck = () => {
    if (released) throw notConnected();
    check();
  };
  const store = projectThread(guarded, inner.store, track);
  const out = Object.create(null) as { store: ThreadSource; release: () => void };
  Object.defineProperty(out, "store", { enumerable: true, get: () => (guarded(), store) });
  out.release = () => {
    if (released) return;
    released = true;
    for (const release of active) {
      try {
        release();
      } catch {
        /* Release is best effort. */
      }
    }
    active.clear();
    inner.release();
  };
  return Object.freeze(out);
}
