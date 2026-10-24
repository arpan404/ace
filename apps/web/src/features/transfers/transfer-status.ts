import type { Transfer } from "@ace/protocol";
import { useOpenOnMachine } from "@/lib/open-on-machine.ts";
import type { LineAction } from "./transfer-line.tsx";
import { cancellable, useTransferActions } from "./use-transfer-actions.ts";
import { doneWords, runningWords } from "./transfer-words.ts";

/**
 * One transfer as its line says it: running with Cancel, done with Open (when this window can
 * show the other machine), failed with the daemon's words and Try again. The same whoever
 * started it: the person here, or an agent.
 */
export function useTransferLine(
  transfer: Transfer,
  retry: (() => void) | undefined,
  /** After Open has switched to the work (the dialog closes). */
  opened?: () => void,
): { words: string; actions: LineAction[]; alert: boolean } {
  const { cancel } = useTransferActions();
  const openOn = useOpenOnMachine();
  const again = retry ? [{ label: "Try again", run: retry }] : [];
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
        words: transfer.error?.message || `Couldn't send it to ${transfer.target.name}.`,
        actions: again,
        alert: true,
      };
    case "cancelled":
      return {
        words: `Cancelled sending to ${transfer.target.name}`,
        actions: again,
        alert: false,
      };
    default:
      return {
        words: runningWords(transfer),
        actions: cancellable(transfer)
          ? [{ label: "Cancel", run: () => void cancel(transfer) }]
          : [],
        alert: false,
      };
  }
}
