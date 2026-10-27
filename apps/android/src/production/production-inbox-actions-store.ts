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

/**
 * Receipt subscriptions admitted through `useProductionInboxActions`.
 * Module-owned (like the Undo offer) so rotation or a view remount keeps the
 * durable receipt path: the hook never disposes on unmount. Entries clear
 * only on host/session teardown below, never on remount or transient
 * offline. Disposing stops the SDK listener; the admitted command stays
 * durable in the outbox.
 */
const uiReceipts = new Map<string, { hostId: string; stop: () => void }>();

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

/** Track one admitted command's receipt listener until it reaches terminal. */
export function trackInboxActionReceipt(hostId: string, commandId: string, stop: () => void): void {
  uiReceipts.set(commandId, { hostId, stop });
}

/** Forget a receipt that reached terminal; the listener already self-cleaned. */
export function untrackInboxActionReceipt(commandId: string): void {
  uiReceipts.delete(commandId);
}

function disposeReceipt(entry: { hostId: string; stop: () => void }): void {
  try {
    entry.stop();
  } catch {
    /* A dead pin between teardown and dispose stays silent. */
  }
}

/**
 * Session/host teardown for one machine: drops its Undo offer, its visible
 * and queued failures, its in-flight busy keys and its receipt listeners so
 * a removed, unpaired or re-paired host never leaves a stale cross-session
 * action behind. Other hosts are untouched. A surviving Undo promotion still
 * applies: clearing a departed host's Undo surfaces the next queued failure
 * for a live host.
 */
export function invalidateInboxActionUiForHost(hostId: string): void {
  const receiptIds: string[] = [];
  for (const [commandId, entry] of uiReceipts) {
    if (entry.hostId === hostId) receiptIds.push(commandId);
  }
  for (const commandId of receiptIds) {
    const entry = uiReceipts.get(commandId);
    if (entry !== undefined) {
      uiReceipts.delete(commandId);
      disposeReceipt(entry);
    }
  }
  if (uiUndo !== null && uiUndo.hostId === hostId) {
    clearUiTimer();
    uiUndo = null;
  }
  if (uiFailed !== null && uiFailed.hostId === hostId) {
    uiFailed = null;
  }
  if (uiPendingFailed.some((entry) => entry.hostId === hostId)) {
    uiPendingFailed = uiPendingFailed.filter((entry) => entry.hostId !== hostId);
  }
  const prefix = `${hostId}:`;
  if (Object.keys(uiBusy).some((key) => key.startsWith(prefix))) {
    const next: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(uiBusy)) {
      if (!key.startsWith(prefix)) next[key] = value;
    }
    uiBusy = next;
  }
  if (uiFailed === null && uiUndo === null && uiPendingFailed.length > 0) {
    uiFailed = uiPendingFailed.shift() ?? null;
  }
  emitInboxActionUiForTests();
}

/** Full teardown (disconnect-all): every host's Undo, failures, busy and receipts. */
export function invalidateAllInboxActionUi(): void {
  for (const [, entry] of uiReceipts) disposeReceipt(entry);
  uiReceipts.clear();
  clearUiTimer();
  uiUndo = null;
  uiFailed = null;
  uiPendingFailed = [];
  uiBusy = {};
  emitInboxActionUiForTests();
}

/**
 * Keep only live hosts (merged-view pairing set): departed hosts invalidate
 * exactly as `invalidateInboxActionUiForHost` would, live hosts keep their
 * Undo, failures, busy and receipt listeners through transient offline.
 */
export function pruneInboxActionUiToHosts(liveHostIds: readonly string[]): void {
  const live = new Set(liveHostIds);
  const departedReceipts: string[] = [];
  for (const [commandId, entry] of uiReceipts) {
    if (!live.has(entry.hostId)) departedReceipts.push(commandId);
  }
  for (const commandId of departedReceipts) {
    const entry = uiReceipts.get(commandId);
    if (entry !== undefined) {
      uiReceipts.delete(commandId);
      disposeReceipt(entry);
    }
  }
  if (uiUndo !== null && !live.has(uiUndo.hostId)) {
    clearUiTimer();
    uiUndo = null;
  }
  if (uiFailed !== null && !live.has(uiFailed.hostId)) {
    uiFailed = null;
  }
  if (uiPendingFailed.some((entry) => !live.has(entry.hostId))) {
    uiPendingFailed = uiPendingFailed.filter((entry) => live.has(entry.hostId));
  }
  if (Object.keys(uiBusy).some((key) => !live.has(key.split(":")[0] ?? ""))) {
    const next: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(uiBusy)) {
      if (live.has(key.split(":")[0] ?? "")) next[key] = value;
    }
    uiBusy = next;
  }
  if (uiFailed === null && uiUndo === null && uiPendingFailed.length > 0) {
    uiFailed = uiPendingFailed.shift() ?? null;
  }
  emitInboxActionUiForTests();
}

/**
 * What the banner may show for the visible hosts: the shared Undo/failure
 * belongs to exactly one host, so a single view passes `[hostId]` and the
 * merged view passes its paired set. Anything for a hidden host stays stored
 * (switching back resurfaces it) but never renders or retries elsewhere.
 */
export function scopedInboxActionUi(liveHostIds: readonly string[]): {
  undo: ProductionInboxUndo | null;
  failed: ProductionInboxFailed | null;
} {
  const live = new Set(liveHostIds);
  return {
    undo: uiUndo !== null && live.has(uiUndo.hostId) ? uiUndo : null,
    failed: uiFailed !== null && live.has(uiFailed.hostId) ? uiFailed : null,
  };
}

/** Reset the module store; tests only. */
export function resetProductionInboxActionUiForTests(): void {
  for (const [, entry] of uiReceipts) {
    try {
      entry.stop();
    } catch {
      /* best effort */
    }
  }
  uiReceipts.clear();
  clearUiTimer();
  uiUndo = null;
  uiFailed = null;
  uiPendingFailed = [];
  uiBusy = {};
}

/** Tracked receipt subscriptions; tests only. */
export function trackedInboxActionReceiptsForTests(): ReadonlyArray<{
  hostId: string;
  commandId: string;
}> {
  return [...uiReceipts.entries()].map(([commandId, entry]) => ({
    hostId: entry.hostId,
    commandId,
  }));
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
