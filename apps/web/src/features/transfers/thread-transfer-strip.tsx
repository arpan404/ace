import { transferRunning } from "@ace/client";
import { useThreadMeta, useThreadTransfer } from "@ace/client-react";
import type { ThreadContinuedOn, ThreadDetails, Transfer } from "@ace/protocol";
import { useState, type ReactNode } from "react";
import { useOpenOnMachine } from "@/lib/open-on-machine.ts";
import { TransferLine } from "./transfer-line.tsx";
import { useTransferLine } from "./transfer-status.ts";
import { useTransferActions } from "./use-transfer-actions.ts";

/** What the thread's strip says about where its work went or came from. Pure. */
export type ThreadTransferState =
  | { kind: "transfer"; transfer: Transfer }
  | { kind: "on"; on: ThreadContinuedOn }
  | { kind: "from"; from: ThreadContinuedOn };

/**
 * A running transfer first, then one that failed after the last continuation (until it's
 * dismissed), then where the thread was continued, a finished transfer whose record hasn't
 * reached the thread yet, then where it came from. Cancelled transfers say nothing.
 */
export function threadTransferState(
  transfer: Transfer | undefined,
  details: Pick<ThreadDetails, "continuedOn" | "continuedFrom"> | undefined,
  dismissed: string | undefined,
): ThreadTransferState | undefined {
  const on = details?.continuedOn;
  if (transfer && transferRunning(transfer)) return { kind: "transfer", transfer };
  if (
    transfer?.phase === "failed" &&
    transfer.transferId !== dismissed &&
    (!on || transfer.updatedAt > on.at)
  )
    return { kind: "transfer", transfer };
  if (on) return { kind: "on", on };
  if (transfer?.phase === "completed") return { kind: "transfer", transfer };
  if (details?.continuedFrom) return { kind: "from", from: details.continuedFrom };
  return undefined;
}

/** Whether the strip has something to say about this thread's transfers. */
export function useThreadTransferState(threadId: string) {
  const transfer = useThreadTransfer(threadId);
  const details = useThreadMeta(threadId)?.details;
  const [dismissed, setDismissed] = useState<string>();
  return {
    state: threadTransferState(transfer, details, dismissed),
    dismiss: setDismissed,
  };
}

/**
 * The thread's transfer in the composer's strip (ADR 0099): "Sending to Studio · 312 MB of
 * 1.2 GB  Cancel", the daemon's words and Try again when it failed, "Continued on Studio  Open"
 * on the thread the work left, "Continued from MacBook  Open" on the one it arrived in.
 */
export function ThreadTransferStrip(props: {
  threadId: string;
  state: ThreadTransferState;
  onDismiss(transferId: string): void;
  indicators: ReactNode;
}) {
  const { state } = props;
  if (state.kind === "transfer")
    return (
      <RunningLine
        threadId={props.threadId}
        transfer={state.transfer}
        onDismiss={props.onDismiss}
        indicators={props.indicators}
      />
    );
  return (
    <ContinuedLine
      words={
        state.kind === "on" ? `Continued on ${state.on.name}` : `Continued from ${state.from.name}`
      }
      where={state.kind === "on" ? state.on : state.from}
      indicators={props.indicators}
    />
  );
}

function RunningLine(props: {
  threadId: string;
  transfer: Transfer;
  onDismiss(transferId: string): void;
  indicators: ReactNode;
}) {
  const { transfer } = props;
  const title = useThreadMeta(props.threadId)?.title ?? "";
  const { start } = useTransferActions();
  const line = useTransferLine(
    transfer,
    () =>
      void start(
        { kind: "thread", threadId: props.threadId, workspaceId: transfer.workspaceId, title },
        { hostId: transfer.target.hostId, includeChanges: true },
      ),
  );
  const actions =
    transfer.phase === "failed"
      ? [...line.actions, { label: "Dismiss", run: () => props.onDismiss(transfer.transferId) }]
      : line.actions;
  return <TransferLine {...line} actions={actions} indicators={props.indicators} />;
}

function ContinuedLine(props: { words: string; where: ThreadContinuedOn; indicators: ReactNode }) {
  const open = useOpenOnMachine()({ hostId: props.where.hostId, threadId: props.where.threadId });
  return (
    <TransferLine
      words={props.words}
      actions={open ? [{ label: "Open", run: open }] : []}
      indicators={props.indicators}
    />
  );
}
