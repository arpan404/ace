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

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object") return value;
  const obj = value as unknown as object;
  if (seen.has(obj)) return value;
  seen.add(obj);
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry as unknown, seen);
    return Object.freeze(value);
  }
  if (value instanceof Date) return Object.freeze(value);
  if (value instanceof Map) {
    for (const [k, v] of value) {
      deepFreeze(k as unknown, seen);
      deepFreeze(v as unknown, seen);
    }
    return Object.freeze(value);
  }
  if (value instanceof Set) {
    for (const entry of value) deepFreeze(entry as unknown, seen);
    return Object.freeze(value);
  }
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) return Object.freeze(value);
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer)
    return Object.freeze(value);
  if (!isPlainObject(obj)) return value;
  for (const key of Reflect.ownKeys(obj) as (string | symbol)[]) {
    try {
      deepFreeze((obj as Record<string | symbol, unknown>)[key] as unknown, seen);
    } catch {
      /* Non-readable keys stay as-is; the container copy still isolates. */
    }
  }
  return Object.freeze(value);
}

function cloneDeepInto<T>(value: T, seen = new Map<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  const obj = value as unknown as object;
  const cached = seen.get(obj);
  if (cached !== undefined) return cached as T;
  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    seen.set(obj, copy);
    return Object.freeze(copy) as unknown as T;
  }
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      const copy = new DataView(buf);
      seen.set(obj, copy);
      return Object.freeze(copy) as unknown as T;
    }
    const Ctor = (value as unknown as { constructor: new (src: unknown) => unknown }).constructor;
    try {
      const copy = new Ctor(value as unknown as ArrayLike<unknown>) as object;
      seen.set(obj, copy);
      return Object.freeze(copy) as unknown as T;
    } catch {
      return value;
    }
  }
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) {
    const copy = value.slice(0);
    seen.set(obj, copy);
    return Object.freeze(copy) as unknown as T;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(obj, copy);
    for (const entry of value) copy.push(cloneDeepInto(entry as unknown, seen));
    return Object.freeze(copy) as unknown as T;
  }
  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>();
    seen.set(obj, copy);
    for (const [k, v] of value) copy.set(cloneDeepInto(k, seen), cloneDeepInto(v, seen));
    return Object.freeze(copy) as unknown as T;
  }
  if (value instanceof Set) {
    const copy = new Set<unknown>();
    seen.set(obj, copy);
    for (const entry of value) copy.add(cloneDeepInto(entry, seen));
    return Object.freeze(copy) as unknown as T;
  }
  if (!isPlainObject(obj)) return value;
  const copy = Object.create(Object.getPrototypeOf(obj)) as Record<string | symbol, unknown>;
  seen.set(obj, copy);
  for (const key of Reflect.ownKeys(obj) as (string | symbol)[]) {
    let desc: PropertyDescriptor | undefined;
    try {
      desc = Object.getOwnPropertyDescriptor(obj, key);
    } catch {
      continue;
    }
    if (!desc || !desc.enumerable) continue;
    try {
      copy[key] = cloneDeepInto((obj as Record<string | symbol, unknown>)[key] as unknown, seen);
    } catch {
      /* Unreadable values stay absent; the copy still isolates what it holds. */
    }
  }
  return Object.freeze(copy) as unknown as T;
}

function cloneFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    return cloneDeepInto(value);
  }
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

export function wrapSelection<T>(check: ReadCheck, inner: Selection<T>): Selection<T> {
  let current: Selection<T> | undefined = inner;
  const out = Object.create(null) as {
    getSnapshot: () => T;
    subscribe: (listener: () => void) => () => void;
  };
  out.getSnapshot = () => {
    check();
    const live = current;
    if (live === undefined) throw notConnected();
    return cloneFreeze(live.getSnapshot());
  };
  out.subscribe = (listener: () => void) => {
    check();
    const live = current;
    if (live === undefined) throw notConnected();
    let stopped = false;
    const detach = () => {
      if (stopped) return;
      stopped = true;
      current = undefined;
      try {
        unsub();
      } catch {
        /* Detach is best effort. */
      }
    };
    const unsub = live.subscribe(() => {
      if (stopped) return;
      try {
        check();
      } catch {
        detach();
        return;
      }
      if (current === undefined) return;
      listener();
    });
    return () => {
      if (stopped) return;
      stopped = true;
      current = undefined;
      unsub();
    };
  };
  return Object.freeze(out);
}

function wrapTrackedSelection<T>(
  check: ReadCheck,
  inner: Selection<T>,
  track: (release: () => void) => () => void,
): Selection<T> {
  let current: Selection<T> | undefined = inner;
  const out = Object.create(null) as {
    getSnapshot: () => T;
    subscribe: (listener: () => void) => () => void;
  };
  out.getSnapshot = () => {
    check();
    const live = current;
    if (live === undefined) throw notConnected();
    return cloneFreeze(live.getSnapshot());
  };
  out.subscribe = (listener: () => void) => {
    check();
    const live = current;
    if (live === undefined) throw notConnected();
    let stopped = false;
    const detach = () => {
      if (stopped) return;
      stopped = true;
      current = undefined;
      try {
        unsub();
      } catch {
        /* Detach is best effort. */
      }
    };
    const unsub = live.subscribe(() => {
      if (stopped) return;
      try {
        check();
      } catch {
        try {
          untrack();
        } catch {
          /* Detach is best effort. */
        }
        detach();
        return;
      }
      if (current === undefined) return;
      listener();
    });
    const untrack = track(() => {
      detach();
    });
    return () => {
      if (stopped) return;
      stopped = true;
      current = undefined;
      try {
        untrack();
      } catch {
        /* Detach is best effort. */
      }
      unsub();
    };
  };
  return Object.freeze(out);
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
  const observeInner = (tap: (keys: ReadonlySet<string> | "all") => void): (() => void) => {
    check();
    let stopped = false;
    let unsub: (() => void) | undefined;
    const detach = () => {
      if (stopped) return;
      stopped = true;
      const stop = unsub;
      unsub = undefined;
      try {
        stop?.();
      } catch {
        /* Detach is best effort. */
      }
    };
    unsub = live.observe((keys) => {
      if (stopped) return;
      try {
        check();
      } catch {
        try {
          untrack?.();
        } catch {
          /* Detach is best effort. */
        }
        detach();
        return;
      }
      tap(copyTapKeys(keys));
    });
    if (track === undefined) {
      return () => {
        detach();
      };
    }
    const untrack = track(() => {
      detach();
    });
    return () => {
      if (stopped) {
        try {
          untrack();
        } catch {
          /* Detach is best effort. */
        }
        return;
      }
      stopped = true;
      try {
        untrack();
      } catch {
        /* Detach is best effort. */
      }
      const stop = unsub;
      unsub = undefined;
      try {
        stop?.();
      } catch {
        /* Detach is best effort. */
      }
    };
  };
  Object.defineProperties(view, {
    error: { enumerable: true, get: () => (check(), freezeError(live.error)) },
    syncing: { enumerable: true, get: () => (check(), live.syncing) },
    unconfirmed: { enumerable: true, get: () => (check(), live.unconfirmed) },
    loaded: { enumerable: true, get: () => (check(), live.loaded) },
    ids: { enumerable: true, get: () => (check(), cloneFreeze(live.ids)) },
    homeWindow: { enumerable: true, get: () => (check(), cloneFreeze(live.homeWindow)) },
    window: { enumerable: true, get: () => (check(), cloneFreeze(live.window)) },
  });
  view["thread"] = (id: string) => {
    check();
    return cloneFreeze(live.thread(id));
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
  const observeInner = (tap: (keys: ReadonlySet<string> | "all") => void): (() => void) => {
    check();
    let stopped = false;
    let unsub: (() => void) | undefined;
    const detach = () => {
      if (stopped) return;
      stopped = true;
      const stop = unsub;
      unsub = undefined;
      try {
        stop?.();
      } catch {
        /* Detach is best effort. */
      }
    };
    unsub = live.observe((keys) => {
      if (stopped) return;
      try {
        check();
      } catch {
        try {
          untrack?.();
        } catch {
          /* Detach is best effort. */
        }
        detach();
        return;
      }
      tap(copyTapKeys(keys));
    });
    if (track === undefined) {
      return () => {
        detach();
      };
    }
    const untrack = track(() => {
      detach();
    });
    return () => {
      if (stopped) {
        try {
          untrack();
        } catch {
          /* Detach is best effort. */
        }
        return;
      }
      stopped = true;
      try {
        untrack();
      } catch {
        /* Detach is best effort. */
      }
      const stop = unsub;
      unsub = undefined;
      try {
        stop?.();
      } catch {
        /* Detach is best effort. */
      }
    };
  };
  Object.defineProperties(view, {
    error: { enumerable: true, get: () => (check(), freezeError(live.error)) },
    syncing: { enumerable: true, get: () => (check(), live.syncing) },
    unconfirmed: { enumerable: true, get: () => (check(), live.unconfirmed) },
    thread: { enumerable: true, get: () => (check(), cloneFreeze(live.thread)) },
    queue: { enumerable: true, get: () => (check(), cloneFreeze(live.queue)) },
    offshift: { enumerable: true, get: () => (check(), cloneFreeze(live.offshift)) },
    context: { enumerable: true, get: () => (check(), cloneFreeze(live.context)) },
    order: { enumerable: true, get: () => (check(), cloneFreeze(live.order)) },
    cursor: { enumerable: true, get: () => (check(), live.cursor) },
    itemsBefore: { enumerable: true, get: () => (check(), live.itemsBefore) },
  });
  view["agentIds"] = () => (check(), cloneFreeze(live.agentIds()));
  view["children"] = (agentId: string) => (check(), cloneFreeze(live.children(agentId)));
  view["interactionIds"] = () => (check(), cloneFreeze(live.interactionIds()));
  view["taskIds"] = () => (check(), cloneFreeze(live.taskIds()));
  view["item"] = (id: string) => (check(), cloneFreeze(live.item(id)));
  view["agent"] = (id: string) => (check(), cloneFreeze(live.agent(id)));
  view["run"] = (id: string) => (check(), cloneFreeze(live.run(id)));
  view["interaction"] = (id: string) => (check(), cloneFreeze(live.interaction(id)));
  view["task"] = (id: string) => (check(), cloneFreeze(live.task(id)));
  view["usage"] = (id: string) => (check(), cloneFreeze(live.usage(id)));
  view["contextMeter"] = (id: string) => (check(), cloneFreeze(live.contextMeter(id)));
  view["usageSnapshot"] = (key: string) => (check(), cloneFreeze(live.usageSnapshot(key)));
  view["truncated"] = (id: string) => (check(), live.truncated(id));
  if (typeof live.runIds === "function")
    view["runIds"] = () => (check(), cloneFreeze(live.runIds?.()));
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
    getSnapshot: () => cloneFreeze(read()),
    subscribe: () => () => {},
  });
}

export function snapshotSidebar(live: SidebarSource): SidebarSource {
  const ids = cloneFreeze(live.ids);
  const rows = new Map<string, unknown>();
  for (const id of live.ids) rows.set(id, cloneFreeze(live.thread(id)));
  const data = {
    error: freezeError(live.error),
    syncing: live.syncing,
    unconfirmed: live.unconfirmed,
    loaded: live.loaded,
    ids,
    homeWindow: cloneFreeze(live.homeWindow),
    window: cloneFreeze(live.window),
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
      thread: cloneFreeze(view.thread),
      queue: cloneFreeze(view.queue),
      offshift: cloneFreeze(view.offshift),
      context: cloneFreeze(context),
      order: cloneFreeze(view.itemOrder ?? []),
      cursor: view.seq,
      itemsBefore: view.itemsBefore ?? null,
      agentIds: cloneFreeze(Object.keys(view.agents ?? {})),
      runIds: cloneFreeze(Object.keys(view.runs ?? {})),
      interactionIds: cloneFreeze(Object.keys(view.interactions ?? {})),
      taskIds: cloneFreeze(Object.keys(view.backgroundTasks ?? {})),
    };
    const items = new Map<string, unknown>();
    for (const [id, entry] of Object.entries(view.items ?? {})) items.set(id, cloneFreeze(entry));
    const agents = new Map<string, unknown>();
    for (const [id, entry] of Object.entries(view.agents ?? {})) agents.set(id, cloneFreeze(entry));
    const runs = new Map<string, unknown>();
    for (const [id, entry] of Object.entries(view.runs ?? {})) runs.set(id, cloneFreeze(entry));
    const interactions = new Map<string, unknown>();
    for (const [id, entry] of Object.entries(view.interactions ?? {}))
      interactions.set(id, cloneFreeze(entry));
    const tasks = new Map<string, unknown>();
    for (const [id, entry] of Object.entries(view.backgroundTasks ?? {}))
      tasks.set(id, cloneFreeze(entry));
    const usage = new Map<string, unknown>();
    for (const [id, entry] of Object.entries(view.usage ?? {})) usage.set(id, cloneFreeze(entry));
    const meters = new Map<string, unknown>();
    for (const [id, entry] of Object.entries(view.contextMeters ?? {}))
      meters.set(id, cloneFreeze(entry));
    const usageSnapshots = new Map<string, unknown>();
    for (const [key, entry] of Object.entries(view.usageSnapshots ?? {}))
      usageSnapshots.set(key, cloneFreeze(entry));
    const children = new Map<string, unknown>();
    for (const [id, entry] of Object.entries(view.agentChildren ?? {}))
      children.set(id, cloneFreeze(entry));
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
  const thread = cloneFreeze(live.thread);
  const queue = cloneFreeze(live.queue);
  const offshift = cloneFreeze(live.offshift);
  const context = cloneFreeze(live.context);
  const data: Record<string, unknown> = {
    error: freezeError(live.error),
    syncing: live.syncing,
    unconfirmed: live.unconfirmed,
    thread,
    queue,
    offshift,
    context,
    order: cloneFreeze(order),
    cursor: live.cursor,
    itemsBefore: live.itemsBefore,
    agentIds: cloneFreeze(agentIds),
    runIds: runIds === undefined ? undefined : cloneFreeze(runIds),
    interactionIds: cloneFreeze(interactionIds),
    taskIds: cloneFreeze(taskIds),
  };
  const items = new Map<string, unknown>();
  for (const id of order) items.set(id, cloneFreeze(live.item(id)));
  const agents = new Map<string, unknown>();
  for (const id of agentIds) agents.set(id, cloneFreeze(live.agent(id)));
  const runs = new Map<string, unknown>();
  if (runIds !== undefined && typeof live.run === "function")
    for (const id of runIds) runs.set(id, cloneFreeze(live.run(id)));
  const interactions = new Map<string, unknown>();
  for (const id of interactionIds) interactions.set(id, cloneFreeze(live.interaction(id)));
  const tasks = new Map<string, unknown>();
  for (const id of taskIds) tasks.set(id, cloneFreeze(live.task(id)));
  const usage = new Map<string, unknown>();
  if (typeof live.usage === "function")
    for (const id of agentIds) {
      const entry = live.usage(id);
      if (entry !== undefined) usage.set(id, cloneFreeze(entry));
    }
  const meters = new Map<string, unknown>();
  if (typeof live.contextMeter === "function")
    for (const id of agentIds) {
      const entry = live.contextMeter(id);
      if (entry !== undefined) meters.set(id, cloneFreeze(entry));
    }
  const usageSnapshots = new Map<string, unknown>();
  const children = new Map<string, unknown>();
  if (typeof live.children === "function")
    for (const id of agentIds) children.set(id, cloneFreeze(live.children(id)));
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
