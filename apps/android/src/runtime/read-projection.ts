import { ClientError } from "@ace/client";
import type { Lease, Selection, SidebarSource, ThreadSource } from "@ace/client";

export type ReadCheck = () => void;

function notConnected(): Error {
  return new Error("This machine is not connected.");
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry as unknown, seen);
    return Object.freeze(value);
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key] as unknown, seen);
  }
  return Object.freeze(value);
}

function cloneFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    if (Array.isArray(value)) return Object.freeze([...(value as unknown[])]) as T;
    return Object.freeze({ ...(value as Record<string, unknown>) }) as T;
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

export function wrapSelection<T>(check: ReadCheck, inner: Selection<T>): Selection<T> {
  const out = Object.create(null) as {
    getSnapshot: () => T;
    subscribe: (listener: () => void) => () => void;
  };
  out.getSnapshot = () => {
    check();
    return inner.getSnapshot();
  };
  out.subscribe = (listener: () => void) => {
    check();
    let stopped = false;
    const unsub = inner.subscribe(() => {
      if (stopped) return;
      try {
        check();
      } catch {
        return;
      }
      listener();
    });
    return () => {
      if (stopped) return;
      stopped = true;
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
  const out = Object.create(null) as {
    getSnapshot: () => T;
    subscribe: (listener: () => void) => () => void;
  };
  out.getSnapshot = () => {
    check();
    return inner.getSnapshot();
  };
  out.subscribe = (listener: () => void) => {
    check();
    let stopped = false;
    const unsub = inner.subscribe(() => {
      if (stopped) return;
      try {
        check();
      } catch {
        return;
      }
      listener();
    });
    const untrack = track(() => {
      if (stopped) return;
      stopped = true;
      unsub();
    });
    return () => {
      if (stopped) return;
      stopped = true;
      untrack();
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
    const unsub = live.observe((keys) => {
      if (stopped) return;
      try {
        check();
      } catch {
        return;
      }
      tap(keys);
    });
    if (track === undefined) {
      return () => {
        if (stopped) return;
        stopped = true;
        unsub();
      };
    }
    const untrack = track(() => {
      if (stopped) return;
      stopped = true;
      unsub();
    });
    return () => {
      if (stopped) return;
      stopped = true;
      untrack();
      unsub();
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
    const unsub = live.observe((keys) => {
      if (stopped) return;
      try {
        check();
      } catch {
        return;
      }
      tap(keys);
    });
    if (track === undefined) {
      return () => {
        if (stopped) return;
        stopped = true;
        unsub();
      };
    }
    const untrack = track(() => {
      if (stopped) return;
      stopped = true;
      unsub();
    });
    return () => {
      if (stopped) return;
      stopped = true;
      untrack();
      unsub();
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
    getSnapshot: read,
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

export function snapshotThread(live: ThreadSource): ThreadSource {
  const snap = Object.create(null) as Record<string, unknown>;
  const data: Record<string, unknown> = {
    error: freezeError(live.error),
    syncing: live.syncing,
    unconfirmed: live.unconfirmed,
    thread: cloneFreeze(live.thread),
    queue: cloneFreeze(live.queue),
    offshift: cloneFreeze(live.offshift),
    context: cloneFreeze(live.context),
    order: cloneFreeze(live.order),
    cursor: live.cursor,
    itemsBefore: live.itemsBefore,
    agentIds: cloneFreeze(live.agentIds()),
    runIds: typeof live.runIds === "function" ? cloneFreeze(live.runIds()) : undefined,
    interactionIds: cloneFreeze(live.interactionIds()),
    taskIds: cloneFreeze(live.taskIds()),
  };
  const items = new Map<string, unknown>();
  for (const id of live.order) items.set(id, cloneFreeze(live.item(id)));
  const agents = new Map<string, unknown>();
  for (const id of live.agentIds()) agents.set(id, cloneFreeze(live.agent(id)));
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
  snap["children"] = (agentId: string) => cloneFreeze(live.children(agentId));
  snap["interactionIds"] = () => data["interactionIds"] as readonly string[];
  snap["taskIds"] = () => data["taskIds"] as readonly string[];
  snap["item"] = (id: string) => items.get(id) as unknown;
  snap["agent"] = (id: string) => agents.get(id) as unknown;
  snap["run"] = (id: string) => cloneFreeze(live.run(id));
  snap["interaction"] = (id: string) => cloneFreeze(live.interaction(id));
  snap["task"] = (id: string) => cloneFreeze(live.task(id));
  snap["usage"] = (id: string) => cloneFreeze(live.usage(id));
  snap["contextMeter"] = (id: string) => cloneFreeze(live.contextMeter(id));
  snap["usageSnapshot"] = (key: string) => cloneFreeze(live.usageSnapshot(key));
  snap["truncated"] = (id: string) => live.truncated(id);
  if (typeof live.itemSeq === "function") snap["itemSeq"] = (id: string) => live.itemSeq?.(id);
  if (typeof live.deleted === "function") snap["deleted"] = (id: string) => live.deleted?.(id);
  if (typeof live.appended === "function")
    snap["appended"] = (a: unknown, b: unknown) =>
      (live.appended as (x: never, y: never) => boolean)(a as never, b as never);
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
