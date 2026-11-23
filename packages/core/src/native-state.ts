// SPDX-License-Identifier: Apache-2.0
/**
 * The native state behind a `ThreadState` (E4). A fold returns events only; the native state is
 * read back through the handle's snapshot the next time TypeScript looks at a field, so a fold
 * that nothing reads costs one crossing instead of a whole state serialization.
 *
 * The handle owns the state: a created view's fields are getters with no setters, so a write
 * fails loudly instead of landing in a copy the next fold would ignore. A state the engine seeds
 * writes into plain data first (`createThreadState`'s `seed`) and then becomes the handle's.
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
  batchBegin(deadlineJson: string | undefined): number;
  batchApply(
    batchId: number,
    factJson: string,
    now: number,
    nextId: (kind: string) => string,
    resolvingJson?: string,
  ): string;
  batchFlush(batchId: number): string;
  /** Replace one top-level field of the handle's state (`null` removes an optional one). */
  setField(field: string, json: string): void;
  reject(dataJson: string, reason: string, now: number, nextId: (kind: string) => string): string;
  adopt(stateJson: string): void;
  /** Replace one top-level state field, as a TypeScript `state[key] = value` does. */
  setField(field: string, json: string): void;
  snapshot(): string;
}

/** One native thread behind a `ThreadState`, with the state bytes it last read. */
interface Slot {
  handle: CoreThreadHandle;
  /** The object the view is built on (absent for a state the caller owns). */
  target: Record<string, unknown> | undefined;
  /** `undefined` once a fold ran: the next field read re-reads the handle's snapshot. */
  state: Record<string, unknown> | undefined;
  /** Whether the state's fields are this module's accessors (else they are plain data). */
  lazy: boolean;
  /** The view's field list, so an unchanged shape costs no property rewrites. */
  fields: string[];
  /** One accessor per field, reused across folds. */
  accessors: Map<string, PropertyDescriptor>;
}

const slots = new WeakMap<object, Slot>();

/** Freeze a parsed state so a write fails loudly instead of landing in a copy. Iterative: a
 * deep raw payload must not grow the stack. */
function freeze(value: unknown): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== "object" || Object.isFrozen(current)) continue;
    Object.freeze(current);
    for (const key of Object.keys(current as Record<string, unknown>))
      stack.push((current as Record<string, unknown>)[key]);
  }
}

function readState(slot: Slot): Record<string, unknown> {
  // One snapshot per fold, and only when TypeScript actually looks at the state. Its keys come
  // in the native serializer's order, which is the order the TypeScript would have written.
  // The core owns this state, so the copy is frozen: a write must not be dropped silently.
  if (slot.state === undefined) {
    slot.state = JSON.parse(slot.handle.snapshot()) as Record<string, unknown>;
    freeze(slot.state);
  }
  return slot.state;
}

function accessor(slot: Slot, field: string): PropertyDescriptor {
  const known = slot.accessors.get(field);
  if (known) return known;
  const descriptor: PropertyDescriptor = {
    configurable: true,
    enumerable: true,
    get: () => readState(slot)[field],
    // A write is the engine's (`state.rootKey = ...`, a read-counting wrapper around a record
    // map, a silence change): it goes into the handle, so the next fold is computed from it.
    set: (value: unknown) => {
      const json = JSON.stringify(value) as string | undefined;
      slot.handle.setField(field, json === undefined ? "null" : json);
      slot.state = undefined;
    },
  };
  slot.accessors.set(field, descriptor);
  return descriptor;
}

/** Give the view exactly the fields the state has, in its own order: absent stays absent. */
function reshape(target: Record<string, unknown>, slot: Slot, fields: string[]): void {
  const same =
    fields.length === slot.fields.length &&
    fields.every((field, index) => field === slot.fields[index]);
  if (same) return;
  slot.fields = fields;
  for (const key of Object.keys(target)) delete target[key];
  for (const field of fields) Object.defineProperty(target, field, accessor(slot, field));
}

/** The native state as a `ThreadState` whose fields are read on demand. */
export function lazyThreadState(handle: CoreThreadHandle): ThreadState {
  const target: Record<string, unknown> = {};
  const slot: Slot = {
    handle,
    target,
    state: JSON.parse(handle.snapshot()) as Record<string, unknown>,
    lazy: true,
    fields: [],
    accessors: new Map(),
  };
  freeze(slot.state);
  reshape(target, slot, Object.keys(slot.state));
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
  slots.set(state, {
    handle,
    target: undefined,
    state: undefined,
    lazy: false,
    fields: [],
    accessors: new Map(),
  });
  return handle;
}

/** Copy fields into a plain state object, dropping the ones it no longer has. */
export function refreshState(target: ThreadState, fresh: ThreadState): void {
  const fields = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(target)) delete fields[key];
  Object.assign(target, fresh);
}

/** The state bytes a fold left behind are stale; the next read asks the handle. */
export function invalidate(state: ThreadState): void {
  const slot = slots.get(state);
  if (slot) slot.state = undefined;
}

/**
 * Read a fold's answer: mark the state stale (a lazy view keeps the shape the fold reported) and
 * return its events. A clone, or a wasm state, is refreshed right away.
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
    if (response.fields !== undefined)
      reshape(state as unknown as Record<string, unknown>, slot, response.fields);
  } else if (slot) {
    refreshState(state, JSON.parse(slot.handle.snapshot()) as ThreadState);
  } else if (response.state !== undefined) {
    refreshState(state, response.state as unknown as ThreadState);
  }
  return response.events;
}
