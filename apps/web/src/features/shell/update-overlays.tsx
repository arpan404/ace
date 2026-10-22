import { useEffect, useRef, type ReactElement, type RefObject } from "react";
import type { UpdateStatus } from "@/boot/desktop-updates.ts";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { RestartConfirm } from "./restart-confirm.tsx";
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
  const confirm = (
    <RestartConfirm
      open={confirming}
      title="Restart to update?"
      busy={busy}
      onOpenChange={onConfirmingChange}
      onRestart={onInstall}
    />
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
