import { useEffect, useRef, type ReactElement, type RefObject } from "react";
import type { UpdateStatus } from "@/boot/desktop-updates.ts";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { UpdateNotes } from "./update-notes.tsx";
import { showsReleaseNotes } from "./update-status.ts";

/** What the Restart does to the agents working in the daemon this app started. */
function restartWords(busy: number | null | undefined): string {
  if (busy === undefined) return "Checking for running agents…";
  if (busy === null)
    return "Agents running on this computer will stop. Their threads keep their progress.";
  if (busy === 0) return "Nothing is running. ace is back in a few seconds.";
  const agents = busy === 1 ? "1 agent on this computer" : `${busy} agents on this computer`;
  return `${agents} will stop. Their threads keep their progress.`;
}

/**
 * The update button's closed layers, off the first paint: the restart confirmation and the
 * release-notes hover card. The button itself stays eager in `update-button.tsx`; this mounts
 * only once there is something to confirm or hover.
 */
export function UpdateOverlays(props: {
  trigger: ReactElement;
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** The eager trigger had keyboard focus when the layers took over; hand it to the new node. */
  restoreFocus: boolean;
  /** The pointer was already over the trigger when the card's code arrived; open on mount. */
  popoverDefaultOpen: boolean;
  label: string;
  status: UpdateStatus;
  scope?: object | undefined;
  confirming: boolean;
  /** Agents on this machine the Restart stops: undefined while counting, null when unknown. */
  busy: number | null | undefined;
  onConfirmingChange: (open: boolean) => void;
  onInstall: () => void;
}) {
  const {
    trigger,
    triggerRef,
    restoreFocus,
    popoverDefaultOpen,
    label,
    status,
    scope,
    confirming,
    busy,
    onConfirmingChange,
    onInstall,
  } = props;
  const restored = useRef(false);
  useEffect(() => {
    if (restoreFocus && !restored.current) {
      restored.current = true;
      triggerRef.current?.focus({ preventScroll: true });
    }
  });
  const stops = busy !== undefined && busy !== 0;
  // Focus starts on Cancel: the count may still be loading when the dialog opens.
  const cancel = useRef<HTMLButtonElement | null>(null);
  const confirm = (
    <Dialog open={confirming} onOpenChange={onConfirmingChange}>
      <DialogContent
        material="glass"
        showCloseButton={false}
        initialFocus={cancel}
        className="w-[min(400px,calc(100vw-2rem))] gap-3 rounded-[20px] p-[22px]"
      >
        <DialogHeader className="pr-0">
          <DialogTitle>Restart to update?</DialogTitle>
          <DialogDescription>{restartWords(busy)}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-2 grid grid-cols-2 gap-2">
          <Button
            ref={cancel}
            type="button"
            variant="secondary"
            onClick={() => onConfirmingChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={stops ? "danger" : "primary"}
            disabled={busy === undefined}
            onClick={() => {
              onConfirmingChange(false);
              onInstall();
            }}
          >
            {stops ? "Restart anyway" : "Restart"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  if (!showsReleaseNotes(status))
    return (
      <>
        <Tip label={label}>{trigger}</Tip>
        {confirm}
      </>
    );
  return (
    <>
      <Popover
        defaultOpen={popoverDefaultOpen}
        onOpenChange={(_open, details) => {
          // A click acts (download, restart); the notes open on hover and focus.
          if (details.reason === "trigger-press") details.cancel();
        }}
      >
        <PopoverTrigger openOnHover delay={150} closeDelay={150} render={trigger} />
        <PopoverContent side="top" align="start" className="p-0" initialFocus={false}>
          <UpdateNotes status={status} scope={scope} />
        </PopoverContent>
      </Popover>
      {confirm}
    </>
  );
}
