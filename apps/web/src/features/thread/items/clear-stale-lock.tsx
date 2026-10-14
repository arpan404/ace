import { useState } from "react";
import { useClient } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
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

/**
 * "Clear stale lock" on a message Git's cleanup fence stopped. After the person confirms, the
 * daemon checks again that the lock's daemon has stopped and only then retires it.
 */
export function ClearStaleLock(props: { threadId: string }) {
  const client = useClient();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [clearing, setClearing] = useState(false);
  const clear = () => {
    setAsking(false);
    setClearing(true);
    void client
      .command({ type: "git.lock.clear", threadId: ThreadId.parse(props.threadId) })
      .then((result) => {
        if (result.ok) toast.add({ title: "Lock cleared", description: "Retry to send it." });
        else
          toast.error({
            title: "The lock is still held",
            description:
              "The ace daemon that holds it may still be running. Stop it, or restart this daemon, then try again.",
          });
      })
      .catch(() =>
        toast.error({ title: "Couldn't clear the lock", description: "Try again in a moment." }),
      )
      .finally(() => setClearing(false));
  };
  return (
    <>
      <Button size="sm" variant="ghost" disabled={clearing} onClick={() => setAsking(true)}>
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
              <Button variant="ghost" onClick={() => setAsking(false)}>
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
