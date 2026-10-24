import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";

/** A change held until the person confirms it: what it is, what it does, and its one action. */
export interface Confirming {
  title: string;
  body: string;
  confirm: string;
  run(): void;
}

/** Confirms a destructive change. Focus starts on Cancel, so Enter never destroys by accident. */
export function ConfirmDialog(props: { confirming: Confirming | undefined; onDone(): void }) {
  // The last change asked about stays written while the dialog fades out.
  const [shown, setShown] = useState(props.confirming);
  const asked = props.confirming;
  if (
    asked &&
    (asked.title !== shown?.title || asked.body !== shown.body || asked.confirm !== shown.confirm)
  )
    setShown(asked);
  const confirming = props.confirming ?? shown;
  return (
    <Dialog open={props.confirming !== undefined} onOpenChange={(open) => !open && props.onDone()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{confirming?.title}</DialogTitle>
          <DialogDescription>{confirming?.body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onDone}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              props.confirming?.run();
              props.onDone();
            }}
          >
            {confirming?.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
