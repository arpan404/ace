// SPDX-License-Identifier: Apache-2.0
/**
 * The native state behind a `ThreadState` (E4). A fold returns events only; the native state is
 * read back through the handle's snapshot the next time TypeScript looks at a field, so a fold
 * that nothing reads costs one crossing instead of a whole state serialization.
 *
 * The handle owns the state. A view's own fields are accessors: reading one asks the handle, and
 * writing one goes into the handle through `setField` (which runs the same validation the
 * constructor does), so nothing lands in a copy the next fold would ignore. A field the state
 * does not have yet keeps its setter (non-enumerable, so `Object.keys`, a spread and
 * `JSON.stringify` do not see it) so assigning it later still reaches the core. The field list
 * and its order come from the handle after every fold, including a failed one.
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

/** One native thread behind a `ThreadState`, with the state bytes it last read. */
interface Slot {
  handle: CoreThreadHandle;
  /** The object whose fields the view exposes (absent for a state the caller owns). */
  target: Record<string, unknown> | undefined;
  /** The view's own fields, in the state's order. */
  fields: string[];
  /** `undefined` once a fold ran: the next field read re-reads the handle's snapshot. */
  state: Record<string, unknown> | undefined;
  /** Whether the state's fields are this module's accessors (else they are plain data). */
  lazy: boolean;
  /** One accessor per field, reused across folds. */
  accessors: Map<string, PropertyDescriptor>;
}

const slots = new WeakMap<object, Slot>();

function readState(slot: Slot): Record<string, unknown> {
  // One snapshot per fold, and only when TypeScript actually looks at the state. Its keys come
  // in the native serializer's order, which is the order the TypeScript would have written.
  slot.state ??= JSON.parse(slot.handle.snapshot()) as Record<string, unknown>;
  return slot.state;
}

/** A field's accessor: reads the handle, writes into it. */
function accessor(slot: Slot, field: string): PropertyDescriptor {
  const known = slot.accessors.get(field);
  if (known) return known;
  const descriptor: PropertyDescriptor = {
    configurable: true,
    // Present fields are the view's own enumerable keys, so `Object.keys`, a spread and
    // `JSON.stringify` see exactly the state's fields in its order.
    enumerable: true,
    get: () => readState(slot)[field],
    set: (value: unknown) => {
      // `undefined` clears the field, as a delete does in the TypeScript reducer; the handle
      // drops it and the next reshape drops its order entry.
      const json = JSON.stringify(value) as string | undefined;
      slot.handle.setField(field, json === undefined ? "null" : json);
      invalidateSlot(slot);
    },
  };
  slot.accessors.set(field, descriptor);
  return descriptor;
}

/** Rebuild the view's own fields: exactly the state's, in its order. A field the state does not
 * have is absent from the object (`in`, `Object.hasOwn`), and its setter is gone with it. */
function reshape(target: Record<string, unknown>, slot: Slot, fields: string[]): void {
  const same =
    fields.length === slot.fields.length &&
    fields.every((field, index) => field === slot.fields[index]) &&
    Object.getOwnPropertyNames(target).length === fields.length;
  if (same) return;
  slot.fields = fields;
  for (const key of Object.getOwnPropertyNames(target)) delete target[key];
  for (const field of fields) Object.defineProperty(target, field, accessor(slot, field));
}

/** Mark the state stale and re-read its field list from the handle. */
function invalidateSlot(slot: Slot): void {
  slot.state = undefined;
  if (!slot.lazy) return;
  const target = slot.target;
  if (target !== undefined) reshape(target, slot, slot.handle.fields());
}

/** The native state as a `ThreadState` whose fields are read on demand. */
export function lazyThreadState(handle: CoreThreadHandle): ThreadState {
  const target: Record<string, unknown> = {};
  const slot: Slot = {
    handle,
    target,
    fields: [],
    state: undefined,
    lazy: true,
    accessors: new Map(),
  };
  reshape(target, slot, handle.fields());
  slots.set(target, slot);
  return target as unknown as ThreadState;
}

/** The handle behind a state, folding a restored snapshot or a clone from its current JSON. */
export function handleFor(
  state: ThreadState,
  open: (stateJson: string) => CoreThreadHandle,
): CoreThreadHandle {
  const known = slots.get(state);
  if (known) return known.handle;
  const handle = open(JSON.stringify(state));
  // The caller's object becomes a view of the handle: identity is kept, so the engine's own
  // references and writes keep working.
  const slot: Slot = {
    handle,
    target: state as unknown as Record<string, unknown>,
    fields: [],
    state: undefined,
    lazy: true,
    accessors: new Map(),
  };
  slots.set(state, slot);
  if (slot.target !== undefined) reshape(slot.target, slot, handle.fields());
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
  (state as unknown as Record<string, unknown>)[field as string] = value;
}

/** The state bytes a fold left behind are stale; the next read asks the handle. */
export function invalidate(state: ThreadState): void {
  const slot = slots.get(state);
  if (slot) invalidateSlot(slot);
}

/**
 * Read a fold's answer: mark the state stale, keep the field shape the fold reported, and give
 * the back its events. A clone, or a wasm state, is refreshed right away.
 */
export function applyResult(state: ThreadState, responseJson: string): EventPayload[] {
  const response = JSON.parse(responseJson) as {
    events: EventPayload[];
    fields?: string[];
    state?: Record<string, unknown>;
  };
  const slot = slots.get(state);
  if (slot?.lazy) {
    slot.state = undefined;
    const target = slot.target;
    if (target !== undefined) reshape(target, slot, response.fields ?? slot.handle.fields());
  } else if (slot) {
    refreshState(state, JSON.parse(slot.handle.snapshot()) as ThreadState);
  } else if (response.state !== undefined) {
    refreshState(state, response.state as unknown as ThreadState);
  }
  return response.events;
}
