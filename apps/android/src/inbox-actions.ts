import type { ClientApi, Intent, Selection } from "@ace/client";
import { ThreadId, type CommandPayload, type ThreadListEntry } from "@ace/protocol";
import { inboxGroup, snoozePresets, type SnoozePreset } from "@ace/ui-core/mobile";

/*
 * Android inbox organization (parity slice A04.03): settle/archive, Undo, unarchive, snooze
 * presets and wake, through the SDK's durable outbox. Payloads and availability mirror the iOS
 * bridge (`apps/ios/bridge/inbox.ts`) and row rules (`Sources/Views/InboxList.swift`); the
 * daemon's canonical list update moves the row. Pure builders stay testable without a device.
 */

export type InboxActionKind = "archive" | "unarchive" | "settle" | "unsettle" | "snooze" | "wake";

export type SnoozePresetId = SnoozePreset["id"];

/**
 * Whether this phone may organize the inbox. Fail closed: only an explicit `true`
 * grants actions, matching iOS (`canOperate ?? false`). Unknown or view-only
 * pairings offer no settle/archive/snooze and admit nothing.
 */
export function canActInbox(canAct: boolean | undefined): boolean {
  return canAct === true;
}

/** The shared snooze presets, resolved against this phone's clock. */
export function snoozeOptions(now: number): SnoozePreset[] {
  return snoozePresets(now);
}

/**
 * Whether a thread id can name a durable command. An empty id reads as no action
 * rather than throwing, like the iOS bridge answering "Could not read that
 * inbox action."
 */
export function isInboxThreadId(threadId: string): boolean {
  return ThreadId.safeParse(threadId).success;
}

/**
 * The durable command for an inbox action. Snooze resolves its preset id to the shared time;
 * an unknown preset or an unreadable thread id admits nothing, like the iOS bridge dropping
 * an unresolvable preset or answering "Could not read that inbox action."
 */
export function inboxActionPayload(
  kind: InboxActionKind,
  threadId: string,
  now: number,
  preset?: SnoozePresetId,
): CommandPayload | undefined {
  const parsed = ThreadId.safeParse(threadId);
  if (!parsed.success) return undefined;
  const id = parsed.data;
  switch (kind) {
    case "archive":
      return { type: "thread.archive", threadId: id };
    case "unarchive":
      return { type: "thread.unarchive", threadId: id };
    case "settle":
      return { type: "thread.settle", threadId: id };
    case "unsettle":
      return { type: "thread.unsettle", threadId: id };
    case "wake":
      return { type: "thread.snooze", threadId: id, until: null };
    case "snooze": {
      const until = snoozePresets(now).find((option) => option.id === preset)?.until;
      return until === undefined ? undefined : { type: "thread.snooze", threadId: id, until };
    }
  }
}

export interface RowInboxActions {
  settle: boolean;
  unsettle: boolean;
  snooze: boolean;
  wake: boolean;
  archive: boolean;
}

/**
 * Which inbox actions a row offers, by the same rules as the iOS row: a settled row offers
 * Unsettle; any other row whose tree is not running offers Settle (the daemon refuses a tree
 * that still runs); a snoozed row offers Wake, otherwise a live row offers Snooze; Archive is
 * always offered. Archived threads never reach this list; they return through Undo.
 * A view-only phone (`canAct` not explicitly true) offers nothing: fail closed.
 */
export function availableInboxActions(
  entry: ThreadListEntry,
  now: number,
  canAct: boolean | undefined = false,
): RowInboxActions {
  if (!canActInbox(canAct))
    return { settle: false, unsettle: false, snooze: false, wake: false, archive: false };
  const group = inboxGroup({ key: "", machineId: "", entry }, now);
  const settled = group === "settled";
  const snoozed = group === "snoozed";
  return {
    settle: !settled && entry.status.state !== "working",
    unsettle: settled,
    snooze: !snoozed && !settled,
    wake: snoozed,
    archive: true,
  };
}

/** The Undo a toast offers after an admitted action: archive takes back, settle unsettles. */
export function undoActionFor(kind: InboxActionKind): "unarchive" | "unsettle" | undefined {
  if (kind === "archive") return "unarchive";
  if (kind === "settle") return "unsettle";
  return undefined;
}

export type InboxActionPort = Pick<ClientApi, "enqueue" | "intent">;

export interface InboxActionOutcome {
  admitted: boolean;
  commandId?: string | undefined;
  error?: string | undefined;
}

/**
 * Admit one inbox action through the SDK's durable outbox. True once saved on this device;
 * the row moves when the daemon's list update lands. A view-only phone admits nothing
 * (fail closed); an unreadable thread id or a rejected save admits nothing and stays
 * retryable by the caller.
 */
export async function runInboxAction(
  port: InboxActionPort,
  kind: InboxActionKind,
  threadId: string,
  now: number,
  preset?: SnoozePresetId,
  canAct: boolean | undefined = false,
): Promise<InboxActionOutcome> {
  if (!canActInbox(canAct))
    return { admitted: false, error: "This phone can only view this machine." };
  if (!isInboxThreadId(threadId))
    return { admitted: false, error: "Could not read that inbox action." };
  const payload = inboxActionPayload(kind, threadId, now, preset);
  if (!payload) return { admitted: false, error: "That snooze time is no longer offered." };
  try {
    const commandId = await port.enqueue(payload);
    return { admitted: true, commandId };
  } catch {
    return { admitted: false, error: "Could not save the request on this device." };
  }
}

/**
 * Follow one admitted command's durable receipt. A refused command reports its error so the
 * caller keeps it retryable; an acknowledged one stays silent. The subscription ends at the
 * first terminal state (refused or acknowledged), so a settled command holds no listener.
 * `onAcked` (optional) lets callers drop their own bookkeeping for the acked command too,
 * so a map keyed by command id never leaks entries the daemon already confirmed.
 * Returns the unsubscribe.
 */
export function watchInboxReceipt(
  port: InboxActionPort,
  commandId: string,
  onRefused: (error: string | undefined) => void,
  onAcked?: () => void,
): () => void {
  const selection: Selection<Intent | undefined> = port.intent(commandId);
  let reported = false;
  let lastError: string | undefined;
  let stop: (() => void) | undefined;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    stop?.();
  };
  const check = () => {
    const snapshot = selection.getSnapshot();
    if (!snapshot) return;
    if (snapshot.state === "failed") {
      if (reported && snapshot.error === lastError) return;
      reported = true;
      lastError = snapshot.error;
      onRefused(snapshot.error);
      finish();
      return;
    }
    if (snapshot.state === "acked") {
      onAcked?.();
      finish();
    }
  };
  stop = selection.subscribe(check);
  check();
  return () => finish();
}
