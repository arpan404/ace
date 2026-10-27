import type { InboxActionKind, SnoozePresetId } from "../inbox-actions.ts";

/**
 * Remount-safe production inbox action state (single + merged views).
 *
 * The Undo offers, the failure queue and the in-flight set live here, outside
 * React, like `interactions.ts` resolutions: rotation or a view remount
 * inside the 5s Undo window keeps the offers and the receipt path. The
 * command itself stays durable in the outbox regardless. No networking, no
 * storage, no React Native imports so unit tests can exercise it directly.
 *
 * Multi-machine isolation: Undo offers are per-host slots (one machine's
 * admit never destroys another's), receipt listeners are nested per
 * host/command, and busy keys carry their owner alongside the key so teardown
 * never parses the key string. A scope downgrade to view-only keeps the route
 * `paired`, so nothing here is dropped on revocation: offers stay stored and
 * the views hide them through `operableScopedInboxActionUi` until the grant
 * returns.
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

/** One live Undo offer per host; each entry owns its expiry timer. */
const uiUndos = new Map<
  string,
  { offer: ProductionInboxUndo; timer: ReturnType<typeof setTimeout> | null }
>();
let uiFailed: ProductionInboxFailed | null = null;
let uiPendingFailed: ProductionInboxFailed[] = [];
let uiBusy: Record<string, boolean> = {};
/**
 * Busy-key owners, recorded at `setUiBusy` time so host teardown never splits
 * the key string (host ids may contain any character, including `:`).
 */
const uiBusyOwners = new Map<string, { hostId: string; threadId: string }>();
const uiListeners = new Set<() => void>();

/**
 * Receipt subscriptions admitted through `useProductionInboxActions`.
 * Module-owned (like the Undo offers) so rotation or a view remount keeps the
 * durable receipt path: the hook never disposes on unmount. Entries clear
 * only on host/session teardown below, never on remount or transient
 * offline. Disposing stops the SDK listener; the admitted command stays
 * durable in the outbox. Nested per host so two machines may track the same
 * command id without colliding.
 */
const uiReceipts = new Map<string, Map<string, { stop: () => void }>>();

export function emitInboxActionUiForTests(): void {
  for (const listener of uiListeners) listener();
}

export function subscribeInboxActionUi(listener: () => void): () => void {
  uiListeners.add(listener);
  return () => {
    uiListeners.delete(listener);
  };
}

function clearUiTimerFor(hostId: string): void {
  const entry = uiUndos.get(hostId);
  if (entry?.timer !== null && entry?.timer !== undefined) {
    clearTimeout(entry.timer);
  }
}

function clearAllUiTimers(): void {
  for (const entry of uiUndos.values()) {
    if (entry.timer !== null) clearTimeout(entry.timer);
  }
}

/** Most recently armed live Undo offer, or null when no host holds one. */
function mostRecentUndo(): ProductionInboxUndo | null {
  let latest: ProductionInboxUndo | null = null;
  for (const entry of uiUndos.values()) latest = entry.offer;
  return latest;
}

/** Most recent live Undo offer among the given hosts, or null. */
function mostRecentUndoFor(live: ReadonlySet<string>): ProductionInboxUndo | null {
  let latest: ProductionInboxUndo | null = null;
  for (const [hostId, entry] of uiUndos) {
    if (live.has(hostId)) latest = entry.offer;
  }
  return latest;
}

function promoteQueuedFailed(): void {
  if (uiFailed === null && uiUndos.size === 0 && uiPendingFailed.length > 0) {
    uiFailed = uiPendingFailed.shift() ?? null;
  }
}

export function readInboxActionUi(): InboxActionUiSnapshot {
  return { undo: mostRecentUndo(), failed: uiFailed, busy: uiBusy };
}

export function armUiUndo(offer: ProductionInboxUndo): void {
  clearUiTimerFor(offer.hostId);
  // Delete-then-set refreshes recency: the re-armed offer reads as newest.
  uiUndos.delete(offer.hostId);
  const entry = { offer, timer: null as ReturnType<typeof setTimeout> | null };
  uiUndos.set(offer.hostId, entry);
  entry.timer = setTimeout(() => {
    const current = uiUndos.get(offer.hostId);
    if (current?.offer.commandId !== offer.commandId) return;
    uiUndos.delete(offer.hostId);
    promoteQueuedFailed();
    emitInboxActionUiForTests();
  }, 5000);
  emitInboxActionUiForTests();
}

/** Clear every host's Undo offer; teardown and legacy callers only. */
export function clearUiUndo(): void {
  clearAllUiTimers();
  uiUndos.clear();
  promoteQueuedFailed();
  emitInboxActionUiForTests();
}

/** Clear one host's Undo offer, leaving every other machine untouched. */
export function clearUiUndoForHost(hostId: string): void {
  clearUiTimerFor(hostId);
  uiUndos.delete(hostId);
  promoteQueuedFailed();
  emitInboxActionUiForTests();
}

/**
 * Clear one host's Undo offer only when it is still the given command, so a
 * re-armed newer offer for the same host is never clobbered by a stale clear.
 */
export function clearUiUndoForCommand(hostId: string, commandId: string): void {
  if (uiUndos.get(hostId)?.offer.commandId !== commandId) return;
  clearUiUndoForHost(hostId);
}

export function reportUiFailed(next: ProductionInboxFailed): void {
  if (mostRecentUndo() !== null || uiFailed !== null || uiPendingFailed.length > 0) {
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

function sameFailed(a: ProductionInboxFailed, b: ProductionInboxFailed): boolean {
  return (
    a.hostId === b.hostId &&
    a.threadId === b.threadId &&
    a.kind === b.kind &&
    a.preset === b.preset &&
    a.message === b.message
  );
}

/**
 * Remove one exact failure (the banner's visible offer) from the visible slot
 * or the queue, so Retry acts on what the user saw. Falls back to the visible
 * failure when the target is already gone.
 */
export function takeInboxActionFailed(target: ProductionInboxFailed): ProductionInboxFailed | null {
  if (uiFailed !== null && (uiFailed === target || sameFailed(uiFailed, target))) {
    const current = uiFailed;
    uiFailed = null;
    promoteQueuedFailed();
    emitInboxActionUiForTests();
    return current;
  }
  const index = uiPendingFailed.findIndex((entry) => entry === target || sameFailed(entry, target));
  if (index >= 0) {
    const [current] = uiPendingFailed.splice(index, 1);
    emitInboxActionUiForTests();
    return current ?? null;
  }
  return consumeUiFailedForRetry();
}

/** Dismiss one exact failure without consuming it for retry. */
export function dismissInboxActionFailed(target?: ProductionInboxFailed | null): void {
  if (target === undefined || target === null) {
    dismissUiFailed();
    return;
  }
  if (uiFailed !== null && (uiFailed === target || sameFailed(uiFailed, target))) {
    uiFailed = null;
    promoteQueuedFailed();
    emitInboxActionUiForTests();
    return;
  }
  const index = uiPendingFailed.findIndex((entry) => entry === target || sameFailed(entry, target));
  if (index >= 0) uiPendingFailed.splice(index, 1);
  emitInboxActionUiForTests();
}

export function dismissUiFailed(): void {
  uiFailed = null;
  promoteQueuedFailed();
  emitInboxActionUiForTests();
}

export function setUiBusy(key: string, on: boolean, hostId?: string, threadId?: string): void {
  if (on) {
    if (uiBusy[key] === true) {
      if (hostId !== undefined && threadId !== undefined) {
        uiBusyOwners.set(key, { hostId, threadId });
      }
      return;
    }
    uiBusy = { ...uiBusy, [key]: true };
    if (hostId !== undefined && threadId !== undefined) {
      uiBusyOwners.set(key, { hostId, threadId });
    }
  } else {
    if (uiBusy[key] === undefined) return;
    const next = { ...uiBusy };
    delete next[key];
    uiBusy = next;
    uiBusyOwners.delete(key);
  }
  emitInboxActionUiForTests();
}

/** Whether the given host has an in-flight action on the given thread. */
export function isInboxActionBusy(hostId: string, threadId: string): boolean {
  for (const owner of uiBusyOwners.values()) {
    if (owner.hostId === hostId && owner.threadId === threadId) return true;
  }
  return false;
}

/**
 * Track one admitted command's receipt listener. Re-tracking the same
 * host/command disposes the previous listener first, so a retry or re-admit
 * that reuses a command id never leaks the first subscription.
 */
export function trackInboxActionReceipt(hostId: string, commandId: string, stop: () => void): void {
  let inner = uiReceipts.get(hostId);
  if (inner === undefined) {
    inner = new Map();
    uiReceipts.set(hostId, inner);
  }
  const previous = inner.get(commandId);
  if (previous !== undefined) disposeReceipt(previous);
  inner.set(commandId, { stop });
}

/** Forget a receipt that reached terminal; the listener already self-cleaned. */
export function untrackInboxActionReceipt(hostId: string, commandId: string): void {
  uiReceipts.get(hostId)?.delete(commandId);
  if (uiReceipts.get(hostId)?.size === 0) uiReceipts.delete(hostId);
}

function disposeReceipt(entry: { stop: () => void }): void {
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
  const inner = uiReceipts.get(hostId);
  if (inner !== undefined) {
    for (const entry of inner.values()) disposeReceipt(entry);
    uiReceipts.delete(hostId);
  }
  clearUiTimerFor(hostId);
  uiUndos.delete(hostId);
  if (uiFailed !== null && uiFailed.hostId === hostId) {
    uiFailed = null;
  }
  if (uiPendingFailed.some((entry) => entry.hostId === hostId)) {
    uiPendingFailed = uiPendingFailed.filter((entry) => entry.hostId !== hostId);
  }
  let droppedBusy = false;
  for (const [key, owner] of uiBusyOwners) {
    if (owner.hostId === hostId) {
      uiBusyOwners.delete(key);
      if (uiBusy[key] !== undefined) {
        const next = { ...uiBusy };
        delete next[key];
        uiBusy = next;
      }
      droppedBusy = true;
    }
  }
  if (!droppedBusy) {
    // Ownerless legacy keys stay put: without an owner they cannot be
    // attributed to the departed host, so only full teardown drops them.
  }
  promoteQueuedFailed();
  emitInboxActionUiForTests();
}

/** Full teardown (disconnect-all): every host's Undo, failures, busy and receipts. */
export function invalidateAllInboxActionUi(): void {
  for (const inner of uiReceipts.values()) {
    for (const entry of inner.values()) disposeReceipt(entry);
  }
  uiReceipts.clear();
  clearAllUiTimers();
  uiUndos.clear();
  uiFailed = null;
  uiPendingFailed = [];
  uiBusy = {};
  uiBusyOwners.clear();
  emitInboxActionUiForTests();
}

/**
 * Keep only live hosts (merged-view pairing set): departed hosts invalidate
 * exactly as `invalidateInboxActionUiForHost` would, live hosts keep their
 * Undo, failures, busy and receipt listeners through transient offline.
 */
export function pruneInboxActionUiToHosts(liveHostIds: readonly string[]): void {
  const live = new Set(liveHostIds);
  for (const [hostId, inner] of uiReceipts) {
    if (!live.has(hostId)) {
      for (const entry of inner.values()) disposeReceipt(entry);
      uiReceipts.delete(hostId);
    }
  }
  for (const hostId of uiUndos.keys()) {
    if (!live.has(hostId)) {
      clearUiTimerFor(hostId);
      uiUndos.delete(hostId);
    }
  }
  if (uiFailed !== null && !live.has(uiFailed.hostId)) {
    uiFailed = null;
  }
  if (uiPendingFailed.some((entry) => !live.has(entry.hostId))) {
    uiPendingFailed = uiPendingFailed.filter((entry) => live.has(entry.hostId));
  }
  for (const [key, owner] of uiBusyOwners) {
    if (!live.has(owner.hostId)) {
      uiBusyOwners.delete(key);
      if (uiBusy[key] !== undefined) {
        const next = { ...uiBusy };
        delete next[key];
        uiBusy = next;
      }
    }
  }
  promoteQueuedFailed();
  emitInboxActionUiForTests();
}

/**
 * What the banner may show for the visible hosts: each host's own Undo and
 * the first failure for a visible host stay stored (switching back resurfaces
 * them) but never render or retry elsewhere.
 */
export function scopedInboxActionUi(liveHostIds: readonly string[]): {
  undo: ProductionInboxUndo | null;
  failed: ProductionInboxFailed | null;
} {
  const live = new Set(liveHostIds);
  let failed: ProductionInboxFailed | null = null;
  if (uiFailed !== null && live.has(uiFailed.hostId)) {
    failed = uiFailed;
  } else {
    failed = uiPendingFailed.find((entry) => live.has(entry.hostId)) ?? null;
  }
  return {
    undo: mostRecentUndoFor(live),
    failed,
  };
}

/**
 * What the banner may show for the visible hosts when grants are known: the
 * scoped offer for a host the phone may still operate on. A revoked
 * (view-only) host keeps its stored offers and listeners — they are hidden,
 * never destroyed — until the grant returns or the host is torn down.
 * Fail-closed: a throwing grant check reads as view-only.
 */
export function operableScopedInboxActionUi(
  liveHostIds: readonly string[],
  canOperate: (hostId: string) => boolean,
): {
  undo: ProductionInboxUndo | null;
  failed: ProductionInboxFailed | null;
} {
  const live = new Set(liveHostIds);
  const operable = (hostId: string): boolean => {
    if (!live.has(hostId)) return false;
    try {
      return canOperate(hostId) === true;
    } catch {
      return false;
    }
  };
  let undo: ProductionInboxUndo | null = null;
  for (const [hostId, entry] of uiUndos) {
    if (operable(hostId)) undo = entry.offer;
  }
  let failed: ProductionInboxFailed | null = null;
  if (uiFailed !== null && operable(uiFailed.hostId)) {
    failed = uiFailed;
  } else {
    failed = uiPendingFailed.find((entry) => operable(entry.hostId)) ?? null;
  }
  return { undo, failed };
}

/** Reset the module store; tests only. */
export function resetProductionInboxActionUiForTests(): void {
  for (const inner of uiReceipts.values()) {
    for (const entry of inner.values()) {
      try {
        entry.stop();
      } catch {
        /* best effort */
      }
    }
  }
  uiReceipts.clear();
  clearAllUiTimers();
  uiUndos.clear();
  uiFailed = null;
  uiPendingFailed = [];
  uiBusy = {};
  uiBusyOwners.clear();
}

/** Tracked receipt subscriptions; tests only. */
export function trackedInboxActionReceiptsForTests(): ReadonlyArray<{
  hostId: string;
  commandId: string;
}> {
  const tracked: Array<{ hostId: string; commandId: string }> = [];
  for (const [hostId, inner] of uiReceipts) {
    for (const commandId of inner.keys()) tracked.push({ hostId, commandId });
  }
  return tracked;
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
  return { undo: mostRecentUndo(), failed: uiFailed, busy: { ...uiBusy } };
}
