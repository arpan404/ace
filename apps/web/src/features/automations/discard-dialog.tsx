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

/** Leaving an edit with unsaved changes: keep editing (the default, and Esc) or discard them. */
export function DiscardDialog(props: { open: boolean; onKeep(): void; onDiscard(): void }) {
  const keep = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onKeep()}>
      <DialogContent initialFocus={keep} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Discard changes to this automation?</DialogTitle>
          <DialogDescription>What you changed here hasn't been saved.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={keep} variant="ghost" onClick={props.onKeep}>
            Keep editing
          </Button>
          <Button variant="danger" onClick={props.onDiscard}>
            Discard
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
