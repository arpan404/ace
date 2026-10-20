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

/** Disabling is machine-wide while the panel is per thread, so it asks first. */
export function DisableDevicesDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onDisable(): void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent initialFocus={cancel}>
        <DialogHeader>
          <DialogTitle>Disable devices on this machine?</DialogTitle>
          <DialogDescription>
            This turns devices off for every thread, not just this one. Agents lose the devices they
            are using, and live views stop.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            ref={cancel}
            type="button"
            variant="ghost"
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={() => {
              props.onOpenChange(false);
              props.onDisable();
            }}
          >
            Disable devices
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
