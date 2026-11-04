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

/** Turning devices off ends what agents and live views are doing on them, so it asks first. */
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
          <DialogTitle>Turn off simulators and emulators?</DialogTitle>
          <DialogDescription>
            This turns them off for every thread on this machine. Agents lose the devices they are
            using, and live views stop. They stay off until you turn them on here.
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
            Turn off
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
