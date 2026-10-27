import type { InboxActionKind, SnoozePresetId } from "../inbox-actions.ts";

/**
 * Remount-safe production inbox action state (single + merged views).
 *
 * The Undo toast, the failure queue and the in-flight set live here, outside
 * React, like `interactions.ts` resolutions: rotation or a view remount
 * inside the 5s Undo window keeps the offer and the receipt path. The command
 * itself stays durable in the outbox regardless. No networking, no storage,
 * no React Native imports so unit tests can exercise it directly.
 */

export interface ProductionInboxUndo {
  hostId: string;
  threadId: string;
  kind: InboxActionKind;
  commandId: string;
  label: string;
}

export interface ProductionInboxFailed {
  hostId: string;
  threadId: string;
  kind: InboxActionKind;
  preset?: SnoozePresetId | undefined;
  message: string;
}

export interface ProductionInboxActionUiOptions {
  /** Display name for a host; returned message is prefixed when it differs. */
  hostLabel?: ((hostId: string) => string | null) | undefined;
}

export interface InboxActionUiSnapshot {
  undo: ProductionInboxUndo | null;
  failed: ProductionInboxFailed | null;
  busy: Record<string, boolean>;
}

let uiUndo: ProductionInboxUndo | null = null;
let uiFailed: ProductionInboxFailed | null = null;
let uiPendingFailed: ProductionInboxFailed[] = [];
let uiBusy: Record<string, boolean> = {};
let uiTimer: ReturnType<typeof setTimeout> | null = null;
const uiListeners = new Set<() => void>();

export function emitInboxActionUiForTests(): void {
  for (const listener of uiListeners) listener();
}

export function subscribeInboxActionUi(listener: () => void): () => void {
  uiListeners.add(listener);
  return () => {
    uiListeners.delete(listener);
  };
}

function clearUiTimer(): void {
  if (uiTimer !== null) {
    clearTimeout(uiTimer);
    uiTimer = null;
  }
}

export function readInboxActionUi(): InboxActionUiSnapshot {
  return { undo: uiUndo, failed: uiFailed, busy: uiBusy };
}

export function armUiUndo(offer: ProductionInboxUndo): void {
  clearUiTimer();
  uiUndo = offer;
  uiTimer = setTimeout(() => {
    uiTimer = null;
    uiUndo = null;
    if (uiFailed === null && uiPendingFailed.length > 0) {
      uiFailed = uiPendingFailed.shift() ?? null;
    }
    emitInboxActionUiForTests();
  }, 5000);
  emitInboxActionUiForTests();
}

export function clearUiUndo(): void {
  clearUiTimer();
  uiUndo = null;
  if (uiFailed === null && uiPendingFailed.length > 0) {
    uiFailed = uiPendingFailed.shift() ?? null;
  }
  emitInboxActionUiForTests();
}

export function reportUiFailed(next: ProductionInboxFailed): void {
  if (uiUndo !== null || uiFailed !== null || uiPendingFailed.length > 0) {
    uiPendingFailed.push(next);
    if (uiPendingFailed.length > 5) uiPendingFailed.shift();
    emitInboxActionUiForTests();
    return;
  }
  uiFailed = next;
  emitInboxActionUiForTests();
}

export function consumeUiFailedForRetry(): ProductionInboxFailed | null {
  const current = uiFailed;
  uiFailed = null;
  emitInboxActionUiForTests();
  return current;
}

export function dismissUiFailed(): void {
  uiFailed = null;
  if (uiPendingFailed.length > 0) {
    uiFailed = uiPendingFailed.shift() ?? null;
  }
  emitInboxActionUiForTests();
}

export function setUiBusy(key: string, on: boolean): void {
  if (on) {
    if (uiBusy[key] === true) return;
    uiBusy = { ...uiBusy, [key]: true };
  } else {
    if (uiBusy[key] === undefined) return;
    const next = { ...uiBusy };
    delete next[key];
    uiBusy = next;
  }
  emitInboxActionUiForTests();
}

/** Reset the module store; tests only. */
export function resetProductionInboxActionUiForTests(): void {
  clearUiTimer();
  uiUndo = null;
  uiFailed = null;
  uiPendingFailed = [];
  uiBusy = {};
}

/** Arm an Undo offer without a daemon round-trip; tests only. */
export function armProductionInboxUndoForTests(offer: ProductionInboxUndo): void {
  armUiUndo(offer);
}

/** Report a failure through the queue path; tests only. */
export function reportProductionInboxFailureForTests(next: ProductionInboxFailed): void {
  reportUiFailed(next);
}

/** Queued failures behind the visible banner; tests only. */
export function pendingProductionInboxFailuresForTests(): readonly ProductionInboxFailed[] {
  return [...uiPendingFailed];
}

/** Read the module snapshot without subscribing; tests only. */
export function snapshotProductionInboxActionUiForTests(): InboxActionUiSnapshot {
  return { undo: uiUndo, failed: uiFailed, busy: { ...uiBusy } };
}
