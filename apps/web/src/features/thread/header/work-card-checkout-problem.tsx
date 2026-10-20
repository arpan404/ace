import { useThreadMeta } from "@ace/client-react";
import type { ThreadDetails } from "@ace/protocol";

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
import { workspaceErrorText } from "../sources/workspace-source.ts";
import type { Move } from "./checkout-move.tsx";
import { failure } from "./use-git-flow.tsx";
import { RowAction, RowLabel, RowStatic } from "./work-card-parts.tsx";

type Change = NonNullable<ThreadDetails["workspaceChange"]>;

/**
 * What stops the thread's checkout, in the Work card's Workspace: a move that failed (or
 * whose outcome ace couldn't confirm) with Retry, which asks for the same move again, and
 * Clear, which releases what the move held once the person confirms; or a worktree folder that
 * is gone, with Move to local and Recreate worktree.
 */
export function CheckoutProblem(props: { thread: ThreadRef; move(move: Move): void }) {
  const details = useThreadMeta(props.thread.id)?.details;
  const change = details?.workspaceChange;
  if (change && (change.state === "failed" || change.uncertain))
    return <FailedMove thread={props.thread} change={change} details={details} move={props.move} />;
  if (details?.worktreeMissing)
    return (
      <RowStatic label="Worktree missing" className="flex-wrap">
        <WarningCircleIcon aria-hidden size={16} className="shrink-0 text-status-failed" />
        <RowLabel>Worktree missing</RowLabel>
        <RowAction
          className="ml-0"
          onClick={() =>
            props.move({ change: { mode: "local" }, done: "Moved to the local checkout" })
          }
        >
          Move to local
        </RowAction>
        <RowAction
          className="ml-0"
          onClick={() =>
            props.move({ change: { mode: "worktree" }, done: "Recreated the worktree" })
          }
        >
          Recreate worktree
        </RowAction>
      </RowStatic>
    );
  return null;
}

function FailedMove(props: {
  thread: ThreadRef;
  change: Change;
  details: ThreadDetails | undefined;
  move(move: Move): void;
}) {
  const { change, details } = props;
  const sources = useThreadSources();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [clearing, setClearing] = useState(false);
  const mode = change.mode ?? details?.mode ?? "local";
  const label = change.uncertain ? "Checkout move unconfirmed" : "Checkout move failed";
  const clear = () => {
    setAsking(false);
    setClearing(true);
    void sources.workspace
      .clearCheckoutMove(props.thread)
      .then(
        () => toast.add({ title: "Move cleared" }),
        (error: unknown) =>
          toast.error({ title: "Couldn't clear the move", description: failure(error) }),
      )
      .finally(() => setClearing(false));
  };
  return (
    <>
      <RowStatic label={change.error ? `${label}. ${workspaceErrorText(change.error)}` : label}>
        <WarningCircleIcon aria-hidden size={16} className="shrink-0 text-status-failed" />
        <RowLabel title={change.error ? workspaceErrorText(change.error) : undefined}>
          {label}
        </RowLabel>
        <RowAction
          className="ml-0"
          onClick={() =>
            props.move({
              change: { mode, ...(change.branch ? { branch: change.branch } : {}) },
              done: mode === "worktree" ? "Moved to a worktree" : "Moved the checkout",
            })
          }
        >
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
