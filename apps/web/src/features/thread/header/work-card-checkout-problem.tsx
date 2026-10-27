import { useThreadMeta } from "@ace/client-react";
import { checkoutProblem, type CheckoutProblem as Problem } from "@ace/ui-core";

import { WarningCircleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import type { Move } from "./checkout-move.tsx";
import { failure } from "./use-git-flow.tsx";
import { RowAction, RowLabel, RowStatic } from "./work-card-parts.tsx";

/**
 * What stops the thread's checkout, in the Work card's Workspace (`checkoutProblem`, shared with
 * the phones): a move that failed (or whose outcome ace couldn't confirm) with Retry, which asks
 * for the same move again, and Clear, which releases what the move held once the person confirms;
 * or a worktree folder that is gone, with Move to local and Recreate worktree. A setup script's
 * failure has its own row (`WorktreeSetupRow`).
 */
export function CheckoutProblem(props: { thread: ThreadRef; move(move: Move): void }) {
  const problem = checkoutProblem(useThreadMeta(props.thread.id)?.details);
  if (problem?.kind === "move-failed" || problem?.kind === "move-unconfirmed")
    return <FailedMove thread={props.thread} problem={problem} move={props.move} />;
  if (problem?.kind === "worktree-missing")
    return (
      <RowStatic label={problem.label} className="flex-wrap">
        <WarningCircleIcon aria-hidden size={16} className="shrink-0 text-status-failed" />
        <RowLabel>{problem.label}</RowLabel>
        {problem.actions.map(
          (action) =>
            action.kind === "move" && (
              <RowAction
                key={action.label}
                className="ml-0"
                onClick={() => props.move({ change: action.move })}
              >
                {action.label}
              </RowAction>
            ),
        )}
      </RowStatic>
    );
  return null;
}

function FailedMove(props: { thread: ThreadRef; problem: Problem; move(move: Move): void }) {
  const { problem } = props;
  const sources = useThreadSources();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [clearing, setClearing] = useState(false);
  const retry = problem.actions.find((action) => action.kind === "retry-move");
  const clear = () => {
    setAsking(false);
    setClearing(true);
    void sources.workspace
      .clearCheckoutMove(props.thread)
      .catch((error: unknown) =>
        toast.error({ title: "Couldn't clear the move", description: failure(error) }),
      )
      .finally(() => setClearing(false));
  };
  return (
    <>
      <RowStatic label={problem.detail ? `${problem.label}. ${problem.detail}` : problem.label}>
        <WarningCircleIcon aria-hidden size={16} className="shrink-0 text-status-failed" />
        <RowLabel title={problem.detail}>{problem.label}</RowLabel>
        <RowAction className="ml-0" onClick={() => retry && props.move({ change: retry.move })}>
          Retry
        </RowAction>
        <RowAction className="ml-0" disabled={clearing} onClick={() => setAsking(true)}>
          Clear
        </RowAction>
      </RowStatic>
      {asking && (
        <Dialog open onOpenChange={(open) => setAsking(open)}>
          <DialogContent size="sm">
            <DialogHeader>
              <DialogTitle>Clear the failed move?</DialogTitle>
              <DialogDescription>
                ace releases the checkout this move reserved, once Git reports it free. The thread
                stays where it is; nothing in either checkout is deleted.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" autoFocus onClick={() => setAsking(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={clear}>
                Clear move
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
