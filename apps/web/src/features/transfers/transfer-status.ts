import { transferCancellable } from "@ace/client";
import type { Transfer } from "@ace/protocol";
import { useState } from "react";
import { useOpenOnMachine } from "@/lib/open-on-machine.ts";
import type { LineAction } from "./transfer-line.tsx";
import { useTransferActions, type Refusal } from "./use-transfer-actions.ts";
import { doneWords, refusalWords, runningWords } from "./transfer-words.ts";

/** Try again: starts it over, and says why when the daemon refused. */
export type Retry = () => Promise<Refusal | undefined> | void;

/**
 * One transfer as its line says it: running with Cancel, done with Open (when this window can
 * show the other machine), failed with the daemon's words and Try again. The same whoever
 * started it: the person here, or an agent. Cancel and Try again are dimmed while they run, and
 * a refusal from either replaces the line's words until the transfer moves on.
 */
export function useTransferLine(
  transfer: Transfer,
  retry: Retry | undefined,
  /** After Open has switched to the work (the dialog closes). */
  opened?: () => void,
): { words: string; actions: LineAction[]; alert: boolean } {
  const { cancel } = useTransferActions();
  const openOn = useOpenOnMachine();
  const [busy, setBusy] = useState<string>();
  const [refused, setRefused] = useState<{ key: string; refusal: Refusal }>();
  // A refusal belongs to the transfer as it was when it was asked.
  const key = `${transfer.transferId}:${transfer.phase}`;
  const refusal = refused?.key === key ? refused.refusal : undefined;
  const run = (label: string, action: () => Promise<Refusal | undefined> | void) => () => {
    const pending = action();
    if (!pending) return;
    setBusy(label);
    void pending.then((outcome) => {
      setBusy(undefined);
      setRefused(outcome ? { key, refusal: outcome } : undefined);
    });
  };
  const again: LineAction[] = retry
    ? [{ label: "Try again", run: run("Try again", retry), disabled: busy === "Try again" }]
    : [];
  const words = (fallback: string) =>
    refusal ? refusalWords(refusal, transfer.target.name) : fallback;
  switch (transfer.phase) {
    case "completed": {
      const open = transfer.result
        ? openOn({
            hostId: transfer.target.hostId,
            workspaceId: transfer.result.workspaceId,
            threadId: transfer.result.threadId,
          })
        : undefined;
      return {
        words: doneWords(transfer),
        actions: open
          ? [
              {
                label: "Open",
                run: () => {
                  open();
                  opened?.();
                },
              },
            ]
          : [],
        alert: false,
      };
    }
    case "failed":
      return {
        words: words(transfer.error?.message || `Couldn't send it to ${transfer.target.name}.`),
        actions: again,
        alert: true,
      };
    case "cancelled":
      return {
        words: words(`Cancelled sending to ${transfer.target.name}`),
        actions: again,
        alert: refusal !== undefined,
      };
    default:
      return {
        words: words(runningWords(transfer)),
        actions: transferCancellable(transfer)
          ? [
              {
                label: "Cancel",
                run: run("Cancel", () => cancel(transfer)),
                disabled: busy === "Cancel",
              },
            ]
          : [],
        alert: refusal !== undefined,
      };
  }
}
