// SPDX-License-Identifier: Apache-2.0
/**
 * The native state behind a `ThreadState` (E4). A fold returns events only; the native state is
 * read back through the handle's snapshot the next time TypeScript looks at a state field, so a
 * fold that nothing reads costs one crossing instead of a whole state serialization.
 *
 * The handle owns the state, and the view is a proxy over an empty object: `get` reads the
 * snapshot, `has`/`ownKeys`/`getOwnPropertyDescriptor` report exactly the fields the state has,
 * in the handle's recorded order, and `set`/`deleteProperty` write through `setField` (which runs
 * the constructor's validation). So an absent field is absent — `in`, `Object.hasOwn`,
 * `Object.keys` and `JSON.stringify` match a TypeScript state — while an assignment to a field
 * the state has not set yet, or one it cleared, still reaches the core.
 */

import type { EventPayload } from "@ace/protocol";
import type { ThreadState } from "./state.ts";

/** One native core thread behind a handle the TypeScript shell holds. */
export interface CoreThreadHandle {
  apply(
    factJson: string,
    now: number,
    nextId: (kind: string) => string,
    resolvingJson?: string,
  ): string;
  batchBegin(deadlineJson: string | undefined, reuseId?: number, preserve?: boolean): number;
  /** A batch's stable-signal eligibility, live or retired by its flush. */
  batchPreserve(batchId: number): boolean | undefined;
  batchApply(
    batchId: number,
    factJson: string,
    now: number,
    nextId: (kind: string) => string,
    resolvingJson?: string,
  ): string;
  batchFlush(batchId: number): string;
  batchReject(
    batchId: number,
    dataJson: string,
    reason: string,
    now: number,
    nextId: (kind: string) => string,
  ): string;
  reject(dataJson: string, reason: string, now: number, nextId: (kind: string) => string): string;
  adopt(stateJson: string): void;
  /** Replace one top-level field, as a TypeScript `state[key] = value` does (`null` clears). */
  setField(field: string, json: string): void;
  /** The state's own key order, after a fold or a refused fold. */
  fields(): string[];
  snapshot(): string;
}

/** One native thread behind a view, with the state bytes it last read. */
interface Slot {
  handle: CoreThreadHandle;
  /** The plain object the view proxies; it holds no state of its own. */
  target: Record<string, unknown>;
  /** `undefined` once a fold ran: the next field read re-reads the handle's snapshot. */
  state: Record<string, unknown> | undefined;
  /** True for this module's view; false for a caller's own state, refreshed by copy. */
  lazy: boolean;
}

const slots = new WeakMap<object, Slot>();

function readState(slot: Slot): Record<string, unknown> {
  // One snapshot per fold, and only when TypeScript actually looks at the state. Its keys come
  // in the native serializer's order, which is the order the TypeScript would have written.
  slot.state ??= JSON.parse(slot.handle.snapshot()) as Record<string, unknown>;
  return slot.state;
}

/** Write one field into the handle and drop the cached snapshot, as `state[field] = value` does. */
function writeField(slot: Slot, field: string, value: unknown): void {
  const json = JSON.stringify(value) as string | undefined;
  slot.handle.setField(field, json === undefined ? "null" : json);
  slot.state = undefined;
}

/** The proxy's traps: reads come from the snapshot, writes and deletes go into the handle. */
function traps(slot: Slot): ProxyHandler<Record<string, unknown>> {
  return {
    get(target, property, receiver) {
      if (typeof property !== "string") return Reflect.get(target, property, receiver);
      return readState(slot)[property];
    },
    set(target, property, value) {
      if (typeof property !== "string") return Reflect.set(target, property, value);
      writeField(slot, property, value);
      return true;
    },
    deleteProperty(target, property) {
      if (typeof property !== "string") return Reflect.deleteProperty(target, property);
      writeField(slot, property, undefined);
      return true;
    },
    /** Absent fields are absent, as they are on a plain state object. */
    has(target, property) {
      if (typeof property !== "string") return Reflect.has(target, property);
      return Object.hasOwn(readState(slot), property);
    },
    ownKeys() {
      return Reflect.ownKeys(readState(slot));
    },
    getOwnPropertyDescriptor(target, property) {
      if (typeof property !== "string") return Reflect.getOwnPropertyDescriptor(target, property);
      const state = readState(slot);
      if (!Object.hasOwn(state, property)) return undefined;
      return { value: state[property], writable: true, enumerable: true, configurable: true };
    },
  };
}

/** The native state as a `ThreadState`: a proxy that never holds a copy of its own. */
export function lazyThreadState(handle: CoreThreadHandle): ThreadState {
  const slot: Slot = { handle, target: {}, state: undefined, lazy: true };
  const view = new Proxy(slot.target, traps(slot));
  slots.set(view, slot);
  return view as unknown as ThreadState;
}

/** The handle behind a state, folding a restored snapshot or a clone from its current JSON. */
export function handleFor(
  state: ThreadState,
  open: (stateJson: string) => CoreThreadHandle,
): CoreThreadHandle {
  const known = slots.get(state);
  if (known) return known.handle;
  const handle = open(JSON.stringify(state));
  // A state the caller owns keeps its identity; each fold's answer is copied into it, since a
  // proxy cannot take the place of an object the caller already holds.
  slots.set(state, {
    handle,
    target: state as unknown as Record<string, unknown>,
    state: undefined,
    lazy: false,
  });
  return handle;
}

/** Copy fields into a plain state object, dropping the ones it no longer has. */
export function refreshState(target: ThreadState, fresh: ThreadState): void {
  const fields = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(target)) delete fields[key];
  Object.assign(target, fresh);
}

/**
 * Write one top-level field of a state, the way `state[field] = value` does. A native view
 * writes into the handle; a plain (TypeScript) state is assigned directly.
 */
export function setStateField(state: ThreadState, field: keyof ThreadState, value: unknown): void {
  const name = field as string;
  const slot = slots.get(state);
  if (slot === undefined) {
    (state as unknown as Record<string, unknown>)[name] = value;
    return;
  }
  // A view writes into its handle, including a field it no longer carries.
  writeField(slot, name, value);
}

/** The state bytes a fold left behind are stale; the next read asks the handle. */
export function invalidate(state: ThreadState): void {
  const slot = slots.get(state);
  if (slot) slot.state = undefined;
}

/**
 * Read a fold's answer: mark the state stale, keep the field shape the fold reported, and give
 * the back its events. A clone, or a wasm state, is refreshed right away.
 */
export function applyResult(state: ThreadState, responseJson: string): EventPayload[] {
  const response = JSON.parse(responseJson) as {
    events: EventPayload[];
    state?: Record<string, unknown>;
  };
  const slot = slots.get(state);
  if (slot?.lazy) {
    slot.state = undefined;
  } else if (slot) {
    refreshState(state, JSON.parse(slot.handle.snapshot()) as ThreadState);
  } else if (response.state !== undefined) {
    refreshState(state, response.state as unknown as ThreadState);
  }
  return response.events;
}
