import { useState } from "react";
import { useClient } from "@ace/client-react";
import { ThreadId, WorkspaceId, type CommandPayload } from "@ace/protocol";
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

/** Whose lock: a thread's checkout (a message it stopped) or a project's repository (a start). */
export type StaleLockTarget = { threadId: string } | { workspaceId: string };

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
  const thread = "threadId" in props.target;
  const clear = () => {
    setAsking(false);
    setBusy(true);
    void client
      .command(clearing(props.target))
      .then((result) => {
        if (result.ok) {
          toast.add({
            title: "Lock cleared",
            description: thread ? "Retry to send it." : "Retry to start the thread.",
          });
          props.onCleared?.();
        } else
          toast.error({
            title: "The lock is still held",
            description:
              "The ace daemon that holds it may still be running. Stop it, or restart this daemon, then try again.",
          });
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
