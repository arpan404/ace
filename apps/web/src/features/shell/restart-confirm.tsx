import { useRef } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";

/** What a restart of the app does to the agents working in the daemon it started. */
function restartWords(busy: number | null | undefined): string {
  if (busy === undefined) return "Checking for running agents…";
  if (busy === null)
    return "Agents running on this computer will stop. Their threads keep their progress.";
  if (busy === 0) return "Nothing is running. ace is back in a few seconds.";
  const agents = busy === 1 ? "1 agent on this computer" : `${busy} agents on this computer`;
  return `${agents} will stop. Their threads keep their progress.`;
}

/**
 * The question before the app restarts (an update, the sandbox setup): how many agents stop.
 * `busy` is undefined while counting and null when the daemon could not say.
 */
export function RestartConfirm(props: {
  open: boolean;
  title: string;
  busy: number | null | undefined;
  onOpenChange: (open: boolean) => void;
  onRestart: () => void;
}) {
  const { open, title, busy, onOpenChange, onRestart } = props;
  const stops = busy !== undefined && busy !== 0;
  // Focus starts on Cancel: the count may still be loading when the dialog opens.
  const cancel = useRef<HTMLButtonElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        material="glass"
        showCloseButton={false}
        initialFocus={cancel}
        className="w-[min(400px,calc(100vw-2rem))] gap-3 rounded-xl p-5.5"
      >
        <DialogHeader className="pr-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{restartWords(busy)}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-2 grid grid-cols-2 gap-2">
          <Button
            ref={cancel}
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={stops ? "danger" : "primary"}
            disabled={busy === undefined}
            onClick={() => {
              onOpenChange(false);
              onRestart();
            }}
          >
            {stops ? "Restart anyway" : "Restart"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
