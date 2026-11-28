import type { Intent, Selection } from "@ace/client";
import { ViewOnlyError, type ProductionStartup } from "../runtime/production-startup.ts";
import { refusalMessage } from "../interactions.ts";
import {
  inboxActionPayload,
  isInboxThreadId,
  type InboxActionKind,
  type SnoozePresetId,
} from "../inbox-actions.ts";

/**
 * Production inbox organization through the per-machine mutation gate.
 *
 * Mirrors the iOS production inbox path (`ClientModel` per-operation `guard
 * canOperate`): every admission re-reads the current grant for the exact host
 * and resolves a fresh `runtimeForMutation(hostId)` gate at call time, so a
 * grant revoked after the row mounted still fails closed before touching the
 * outbox or the wire. The gate itself pins the exact owner (epoch + device +
 * pin), so a cached gate never forwards to a replacement owner. Rows stay
 * readable while view-only: only admission is gated, and receipts stay
 * readable through `runtimeForReading(hostId).intent`.
 *
 * Payloads and row availability reuse the reviewed dev builders
 * (`inbox-actions.ts`, which mirror the iOS bridge `apps/ios/bridge/inbox.ts`
 * and row rules): no new contract, no iOS/daemon edits. Android only.
 */

/** Narrowest startup surface inbox actions need: admission plus read-only receipts. */
export type ProductionInboxActionsStartup = Pick<
  ProductionStartup,
  "runtimeForMutation" | "runtimeForReading" | "canOperate"
>;

export interface ProductionInboxActionOutcome {
  admitted: boolean;
  commandId?: string | undefined;
  error?: string | undefined;
}

/** View-only copy for a refused production admission. Uses the gate's own words. */
export const PRODUCTION_INBOX_VIEW_ONLY_COPY =
  "View only. Pair this phone with View and act to make changes.";

/** Whether the production row may offer organize actions. Fail closed. */
export function canShowProductionInboxActions(canOperate: boolean | undefined): boolean {
  return canOperate === true;
}

/** Read the current grant for one host, fail-closed on unknown hosts and throws. */
export function currentProductionInboxGrant(
  canOperate: (hostId: string) => boolean,
  hostId: string,
): boolean {
  try {
    return canOperate(hostId) === true;
  } catch {
    return false;
  }
}

/** Screen copy for a thrown production inbox admission failure. */
export function productionInboxActionFailureCopy(error: unknown): string {
  if (error instanceof ViewOnlyError) return error.message;
  if (error instanceof Error && /not connected/i.test(error.message)) {
    return "This machine is not connected.";
  }
  return "Could not save the request on this device.";
}

/** Name a daemon refusal for an inbox action; the caller keeps it retryable. */
export function productionInboxRefusalCopy(error: string | undefined): string {
  return refusalMessage(error, "This change could not be applied.");
}

/**
 * Prefix a failure with its host's display name when the view shows more
 * than one machine. Single-machine views pass no label and keep the plain
 * copy; merged views pass `machineLabelFor` so a refusal names its machine,
 * like iOS prefixing when `showsMachineNames`. Never throws.
 */
export function withHostAttribution(
  message: string,
  hostId: string,
  hostLabel?: ((hostId: string) => string | null) | undefined,
): string {
  let label: string | null = null;
  try {
    label = hostLabel?.(hostId) ?? null;
  } catch {
    label = null;
  }
  if (label === null || label === hostId) return message;
  return `${label}: ${message}`;
}

/** Spoken label for the Undo toast; names which action it takes back. */
export function inboxUndoAccessibilityLabel(undo: { kind: InboxActionKind }): string {
  if (undo.kind === "archive") return "Undo archive";
  if (undo.kind === "settle") return "Undo settle";
  return "Undo";
}

/**
 * Admit one inbox action through a freshly resolved gate. The gate is local to
 * this call and discarded after: nothing is cached, so revocation, disconnect,
 * removal or replacement between renders still fails here, immediately before
 * the mutation. Input validates before the gate resolves, so an unreadable id
 * or an unknown snooze preset never reaches the wire.
 */
export async function runProductionInboxAction(
  startup: ProductionInboxActionsStartup,
  hostId: string,
  kind: InboxActionKind,
  threadId: string,
  now: number,
  preset?: SnoozePresetId | undefined,
): Promise<ProductionInboxActionOutcome> {
  let operate = false;
  try {
    operate = startup.canOperate(hostId) === true;
  } catch {
    operate = false;
  }
  if (!operate) return { admitted: false, error: PRODUCTION_INBOX_VIEW_ONLY_COPY };
  if (!isInboxThreadId(threadId))
    return { admitted: false, error: "Could not read that inbox action." };
  const payload = inboxActionPayload(kind, threadId, now, preset);
  if (!payload) return { admitted: false, error: "That snooze time is no longer offered." };
  try {
    const gate = startup.runtimeForMutation(hostId);
    const commandId = await gate.enqueue(payload);
    return { admitted: true, commandId };
  } catch (error) {
    return { admitted: false, error: productionInboxActionFailureCopy(error) };
  }
}

/**
 * Follow one admitted command's durable receipt through the read-only handle,
 * so receipts stay readable while view-only. A refused command reports its
 * error so the caller keeps it retryable; an acknowledged one stays silent.
 * The subscription ends at the first terminal state, so a settled command
 * holds no listener. Returns the unsubscribe. When the read handle itself is
 * dead, reports "not connected" immediately and returns a no-op.
 */
export function watchProductionInboxReceipt(
  startup: Pick<ProductionInboxActionsStartup, "runtimeForReading">,
  hostId: string,
  commandId: string,
  onRefused: (error: string | undefined) => void,
  onAcked?: () => void,
): () => void {
  let selection: Selection<Intent | undefined>;
  try {
    selection = startup.runtimeForReading(hostId).intent(commandId);
  } catch (error) {
    onRefused(productionInboxActionFailureCopy(error));
    return () => {};
  }
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
    let snapshot: Intent | undefined;
    try {
      snapshot = selection.getSnapshot();
    } catch {
      return;
    }
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
  try {
    stop = selection.subscribe(check);
  } catch {
    return () => {};
  }
  try {
    check();
  } catch {
    /* A dead pin between subscribe and read stays silent; the next notify retries. */
  }
  return () => finish();
}
