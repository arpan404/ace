import { useState } from "react";
import { useClient } from "@ace/client-react";
import { ThreadId, WorkspaceId, type CommandPayload } from "@ace/protocol";
import { staleLockOutcome, type StaleLockTarget } from "@ace/ui-core";
import { LockOpenIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { useToast } from "@/components/ui/toast.tsx";

const clearing = (target: StaleLockTarget): CommandPayload =>
  "threadId" in target
    ? { type: "git.lock.clear", threadId: ThreadId.parse(target.threadId) }
    : { type: "workspace.git.lock.clear", workspaceId: WorkspaceId.parse(target.workspaceId) };

/**
 * "Clear stale lock" where Git's cleanup fence stopped something: a message, or a new thread's
 * worktree. After the person confirms, the daemon checks again that the lock's daemon has
 * stopped and only then retires it; then Retry (or Send) runs it again.
 */
export function ClearStaleLock(props: { target: StaleLockTarget; onCleared?(): void }) {
  const client = useClient();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const clear = () => {
    setAsking(false);
    setBusy(true);
    void client
      .command(clearing(props.target))
      .then((result) => {
        const outcome = staleLockOutcome(result, props.target);
        if (outcome.ok) {
          toast.add({ title: outcome.title, description: outcome.detail });
          props.onCleared?.();
        } else toast.error({ title: outcome.title, description: outcome.detail });
      })
      .catch(() =>
        toast.error({ title: "Couldn't clear the lock", description: "Try again in a moment." }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAsking(true)}>
        <Icon icon={LockOpenIcon} size={12} />
        Clear stale lock
      </Button>
      {asking && (
        <Dialog open onOpenChange={(open) => setAsking(open)}>
          <DialogContent>
            <DialogTitle>Clear the stale Git lock?</DialogTitle>
            <DialogDescription>
              A Git operation an earlier ace daemon started never confirmed its cleanup. ace clears
              the lock only after checking that daemon has stopped. Continue only if nothing it
              started is still changing these files.
            </DialogDescription>
            <DialogFooter>
              <Button variant="ghost" autoFocus onClick={() => setAsking(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={clear}>
                Clear lock
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
