import { useThreadMeta } from "@ace/client-react";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { failureMessage, useDaemonReady } from "@/lib/daemon-command.ts";
import { useThreadSources } from "../sources/index.ts";

export function RewindControl(props: { threadId: string; entryId: string }) {
  const meta = useThreadMeta(props.threadId);
  const sources = useThreadSources();
  const ready = useDaemonReady();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  if (meta?.provider !== "pi") return null;
  const idle = meta.status.state === "done" || meta.status.state === "failed";
  const rewind = async () => {
    if (sending || !idle || !ready.ready) return;
    setSending(true);
    setError(undefined);
    try {
      await sources.actions.rewind(props.threadId, props.entryId);
      setOpen(false);
      toast.add({
        title: "Conversation rewound",
        description: "Files are unchanged. Your next message continues from this turn.",
      });
    } catch (failure) {
      setError(failureMessage(failure));
    } finally {
      setSending(false);
    }
  };
  return (
    <>
      <IconButton
        icon={ClockCounterClockwiseIcon}
        label="Rewind to here"
        size="sm"
        disabled={!idle || !ready.ready}
        reason={
          !idle
            ? "Wait for all agents to finish"
            : ready.ready
              ? undefined
              : "Reconnect to ace on this machine"
        }
        onClick={() => {
          setError(undefined);
          setOpen(true);
        }}
      />
      {open && (
        <Dialog open onOpenChange={(next) => !next && !sending && setOpen(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Rewind to here?</DialogTitle>
              <DialogDescription>
                Your next message continues from this turn. Later turns stay visible in ace, but Pi
                won't use them as context. Files are not reverted.
              </DialogDescription>
            </DialogHeader>
            {error && (
              <p role="alert" className="text-ui text-status-failed">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={sending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                disabled={sending || !idle || !ready.ready}
                onClick={() => void rewind()}
              >
                {sending ? "Rewinding…" : "Rewind"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
