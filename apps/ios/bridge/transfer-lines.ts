import { transferCancellable } from "@ace/client";
import type { Transfer } from "@ace/protocol";
import {
  doneWords,
  refusalWords,
  runningWords,
  type Refusal,
  type ThreadTransferState,
} from "@ace/ui-core/transfers";

/*
 * What the phone draws for a transfer (ADR 0101), worked out here so Swift only lays it out:
 * one sentence with its text buttons. Pure.
 */

/** A text button on a transfer's line. `open` is Swift's to route; the rest come back here. */
export type LineAct = "cancel" | "retry" | "dismiss" | "open";

export interface LineAction {
  act: LineAct;
  label: string;
  disabled: boolean;
}

/** One sentence and its text buttons: "Sending to Studio · 312 MB of 1.2 GB  Cancel". */
export interface Line {
  transferId: string | null;
  words: string;
  /** Failed or refused: read out as an alert, never tinted. */
  alert: boolean;
  actions: LineAction[];
  /** Where Open goes, on the machine the work is on now. */
  open: { hostId: string; threadId: string | null; workspaceId: string | null } | null;
}

/** What "Continue on…" or "Open on…" carries. */
export type Subject =
  | { kind: "thread"; threadId: string; title: string }
  | { kind: "project"; workspaceId: string; name: string };

/** A refusal shown on a transfer's line, for the transfer as it was when it was asked. */
export interface HeldRefusal {
  key: string;
  refusal: Refusal;
}

/** The key a refusal or a pressed button belongs to: it lapses once the transfer moves on. */
export const lineKey = (transfer: Pick<Transfer, "transferId" | "phase">) =>
  `${transfer.transferId}:${transfer.phase}`;

const action = (act: LineAct, label: string, disabled = false): LineAction => ({
  act,
  label,
  disabled,
});

/**
 * A transfer's line, whoever started it (the person or an agent): running with Cancel until
 * `starting`, done with Open, failed with the daemon's words and Try again. A refusal of
 * Cancel or Try again replaces the words until the transfer moves on.
 */
export function transferLine(
  transfer: Transfer,
  options: {
    /** Whether Try again can be offered here. */
    retry: boolean;
    refused?: HeldRefusal | undefined;
    /** The button pressed on this transfer as it is now, dimmed until it answers. */
    busy?: LineAct | undefined;
    /** The thread's strip also offers Dismiss on a failure. */
    dismiss?: boolean;
  },
): Line {
  const key = lineKey(transfer);
  const refusal = options.refused?.key === key ? options.refused.refusal : undefined;
  const machine = transfer.target.name;
  const words = (fallback: string) => (refusal ? refusalWords(refusal, machine) : fallback);
  const again = options.retry ? [action("retry", "Try again", options.busy === "retry")] : [];
  const base = { transferId: transfer.transferId, open: null };
  switch (transfer.phase) {
    case "completed":
      return {
        ...base,
        words: doneWords(transfer),
        alert: false,
        actions: transfer.result ? [action("open", "Open")] : [],
        open: transfer.result
          ? {
              hostId: transfer.target.hostId,
              threadId: transfer.result.threadId ?? null,
              workspaceId: transfer.result.workspaceId,
            }
          : null,
      };
    case "failed":
      return {
        ...base,
        words: words(
          refusalWords({ code: transfer.error?.code, detail: transfer.error?.message }, machine),
        ),
        alert: true,
        actions: options.dismiss ? [...again, action("dismiss", "Dismiss")] : again,
      };
    case "cancelled":
      return {
        ...base,
        words: words(`Cancelled sending to ${machine}`),
        alert: refusal !== undefined,
        actions: again,
      };
    default:
      return {
        ...base,
        words: words(runningWords(transfer)),
        alert: refusal !== undefined,
        actions: transferCancellable(transfer)
          ? [action("cancel", "Cancel", options.busy === "cancel")]
          : [],
      };
  }
}

/** The thread's line above the composer, from `threadTransferState`. */
export function threadLine(
  state: ThreadTransferState | undefined,
  options: { refused?: HeldRefusal | undefined; busy?: LineAct | undefined },
): Line | null {
  if (!state) return null;
  if (state.kind === "transfer")
    return transferLine(state.transfer, { ...options, retry: true, dismiss: true });
  const where = state.kind === "on" ? state.on : state.from;
  return {
    transferId: null,
    words: state.kind === "on" ? `Continued on ${where.name}` : `Continued from ${where.name}`,
    alert: false,
    actions: [action("open", "Open")],
    open: { hostId: where.hostId, threadId: where.threadId, workspaceId: null },
  };
}
