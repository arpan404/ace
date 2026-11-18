import { useThreadMeta, useThreadTransfer, useTransferDismissal } from "@ace/client-react";
import type { ThreadContinuedOn, Transfer } from "@ace/protocol";
import {
  continuedWords,
  threadTransferState,
  type ThreadTransferState,
} from "@ace/ui-core/transfers";
import type { ReactNode } from "react";
import { useScopedMachine } from "@/lib/machines.ts";
import { useOpenOnMachine } from "@/lib/open-on-machine.ts";
import { useTransferOpener, type TransferRequest } from "@/lib/transfer-opener.ts";
import { TransferLine } from "./transfer-line.tsx";
import { useTransferLine } from "./transfer-status.ts";
import { placementOf, useTransferActions } from "./use-transfer-actions.ts";

export type { ThreadTransferState } from "@ace/ui-core/transfers";

/**
 * Whether the strip has something to say about this thread's transfers. A dismissed failure
 * stays dismissed for as long as the window follows that machine, wherever the thread reopens.
 */
export function useThreadTransferState(threadId: string) {
  const transfer = useThreadTransfer(threadId);
  const meta = useThreadMeta(threadId);
  const { dismissed, dismiss } = useTransferDismissal(transfer?.transferId);
  return {
    state: threadTransferState(transfer, meta?.details, dismissed, meta?.status),
    dismiss,
  };
}

/**
 * The thread's transfer in the composer's strip (ADR 0101): "Sending to Studio · 312 MB of
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
  const { words, where } = continuedWords(state);
  return <ContinuedLine words={words} where={where} indicators={props.indicators} />;
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
  const opener = useTransferOpener();
  const scoped = useScopedMachine()?.id;
  const request: TransferRequest = {
    kind: "thread",
    threadId: props.threadId,
    workspaceId: transfer.workspaceId,
    title,
    ...(scoped ? { hostId: scoped } : {}),
  };
  const placement = placementOf(transfer);
  // The same choices again; a daemon that didn't echo them asks for them once more.
  const line = useTransferLine(
    transfer,
    placement
      ? async () => {
          const started = await start(request, placement);
          return started.ok ? undefined : started;
        }
      : () => opener.open({ ...request, machine: transfer.target }),
  );
  const actions =
    transfer.phase === "failed"
      ? [...line.actions, { label: "Dismiss", run: () => props.onDismiss(transfer.transferId) }]
      : line.actions;
  return <TransferLine {...line} actions={actions} indicators={props.indicators} />;
}

function ContinuedLine(props: {
  words: string;
  where: Pick<ThreadContinuedOn, "hostId" | "threadId">;
  indicators: ReactNode;
}) {
  const open = useOpenOnMachine()({ hostId: props.where.hostId, threadId: props.where.threadId });
  return (
    <TransferLine
      words={props.words}
      actions={open ? [{ label: "Open", run: open }] : []}
      indicators={props.indicators}
    />
  );
}
