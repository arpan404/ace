// SPDX-License-Identifier: Apache-2.0
/**
 * The native state behind a `ThreadState` (E4). A fold returns events only; the native state
 * is read back through the handle's snapshot the next time TypeScript looks at a field, so a
 * fold that nothing reads costs one crossing instead of a whole state serialization. A state
 * that a test cloned or restored keeps plain fields and is refreshed after every call.
 */

import type { EventPayload } from "@ace/protocol";
import type { ThreadState } from "./state.ts";

/** One native core thread behind a handle the TypeScript shell holds. */
export interface CoreThreadHandle {
  apply(factJson: string, now: number, nextId: (kind: string) => string): string;
  batchBegin(deadlineJson: string | undefined): void;
  batchApply(factJson: string, now: number, nextId: (kind: string) => string): string;
  batchFlush(): string;
  snapshot(): string;
}

/**
 * The `ThreadState` keys, in the order `createThreadState` builds them (then the fields the
 * fold appends). Native wraps each as an accessor over the handle's state.
 */
const STATE_FIELDS = [
  "threadId",
  "config",
  "initialRoot",
  "agents",
  "runs",
  "items",
  "interactions",
  "tasks",
  "uncertainTasks",
  "interactionHistory",
  "taskHistory",
  "indexes",
  "outcomeOrder",
  "pendingNotices",
  "itemLinks",
  "queueCount",
  "queueSources",
  "hasRun",
  "status",
  "rootKey",
  "processExit",
  "lastTransportSignalAt",
  "statusObservedAt",
  "runSeq",
  "personTasks",
  "rejectionNotices",
  "queueHeld",
  "queueStopped",
  "movedTo",
] as const;

/** One native thread behind a `ThreadState`, with the state bytes it last read. */
interface Slot {
  handle: CoreThreadHandle;
  /** `undefined` once a fold ran: the next field read re-reads the handle's snapshot. */
  state: Record<string, unknown> | undefined;
  /** Whether the state's fields are this module's accessors (else they are plain data). */
  lazy: boolean;
  /** One accessor per field, reused so invalidating costs no allocations. */
  accessors: PropertyDescriptorMap;
}

const slots = new WeakMap<object, Slot>();

function readState(slot: Slot): Record<string, unknown> {
  // One snapshot per fold, and only when TypeScript actually looks at the state: the fields
  // keep the native serializer's own order, so a state read back stringifies like the
  // TypeScript's.
  slot.state ??= JSON.parse(slot.handle.snapshot()) as Record<string, unknown>;
  return slot.state;
}

/** The native state as a `ThreadState` whose fields are read on demand. */
export function lazyThreadState(handle: CoreThreadHandle): ThreadState {
  const target: Record<string, unknown> = {};
  const slot: Slot = {
    handle,
    state: JSON.parse(handle.snapshot()) as Record<string, unknown>,
    lazy: true,
    accessors: {},
  };
  for (const field of STATE_FIELDS)
    slot.accessors[field] = {
      configurable: true,
      enumerable: true,
      get: () => readState(slot)[field],
      // The engine still sets a field before the core knows it (a restored root key); the
      // next fold's snapshot is authoritative again, like an eager refresh was.
      set: (value: unknown) => {
        readState(slot)[field] = value;
      },
    };
  Object.defineProperties(target, slot.accessors);
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
  slots.set(state, { handle, state: undefined, lazy: false, accessors: {} });
  return handle;
}

/** Copy fields into a plain state object, dropping the ones it no longer has. */
export function refreshState(target: ThreadState, fresh: ThreadState): void {
  const fields = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(target)) delete fields[key];
  Object.assign(target, fresh);
}

/**
 * Mark the state stale after a fold and return its events. A lazy state re-reads its handle on
 * the next field read; any other state (a clone, or a wasm state) is refreshed right away.
 */
export function applyResult(state: ThreadState, responseJson: string): EventPayload[] {
  const response = JSON.parse(responseJson) as {
    events: EventPayload[];
    state?: Record<string, unknown>;
  };
  const slot = slots.get(state);
  if (slot?.lazy) slot.state = undefined;
  else if (slot) refreshState(state, JSON.parse(slot.handle.snapshot()) as ThreadState);
  else if (response.state !== undefined)
    refreshState(state, response.state as unknown as ThreadState);
  return response.events;
}
