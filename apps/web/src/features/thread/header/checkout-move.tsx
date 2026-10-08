import { useState, type ReactNode } from "react";
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
import { WorkspaceError, type CheckoutChange } from "../sources/workspace-source.ts";
import { failure } from "./use-git-flow.tsx";

export interface Move {
  change: CheckoutChange;
  /** The toast once it is done ("Switched to develop"). */
  done: string;
  /** A branch switch in place: the branch the uncommitted changes come along to. */
  carriesTo?: string | undefined;
}

/**
 * Moving a thread's checkout: onto another branch, into a worktree, or back to the local
 * checkout. When the daemon refuses because of uncommitted changes, the person can go ahead:
 * a branch switch brings the changes along (Git refuses if they clash), a move back to the local
 * checkout leaves them in the worktree. The question outlives the menu that asked.
 */
export function useCheckoutMove(thread: ThreadRef): {
  move(move: Move): void;
  dialog: ReactNode;
} {
  const sources = useThreadSources();
  const toast = useToast();
  const [dirty, setDirty] = useState<Move>();
  const move = (next: Move) =>
    void sources.workspace.setCheckout(thread, next.change).then(
      () => toast.add({ title: next.done }),
      (error: unknown) => {
        if (
          error instanceof WorkspaceError &&
          error.code === "git_dirty_worktree" &&
          !next.change.allowUncommitted
        )
          return setDirty(next);
        toast.error({ title: "Couldn't move the checkout", description: failure(error) });
      },
    );
  const carriesTo = dirty?.carriesTo;
  return {
    move,
    dialog: dirty && (
      <Dialog open onOpenChange={(open) => !open && setDirty(undefined)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>The checkout has uncommitted changes</DialogTitle>
            <DialogDescription>
              {carriesTo
                ? `Git carries them to ${carriesTo} unless they clash with it.`
                : "They stay where they are, on the current branch, for you to commit later."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDirty(undefined)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              autoFocus
              onClick={() => {
                setDirty(undefined);
                move({ ...dirty, change: { ...dirty.change, allowUncommitted: true } });
              }}
            >
              {carriesTo ? "Switch anyway, bringing changes along" : "Move anyway"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ),
  };
}
