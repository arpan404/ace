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
  const confirm = (
    <Dialog open={confirming} onOpenChange={onConfirmingChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restart to install ace {status.version}?</DialogTitle>
          <DialogDescription>
            ace waits for running agents to finish, then restarts. New work waits until it's back.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" onClick={() => onConfirmingChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              onConfirmingChange(false);
              onInstall();
            }}
          >
            Restart
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
