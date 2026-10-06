import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { useWorkspaceStore, type CloseWarning } from "@/lib/workspace/index.ts";

/**
 * The question asked before closing tabs that would stop something (a terminal's running
 * shell): the screen's workspace actions wait on it. Cancel, Escape and a click outside keep
 * the tabs; focus goes back to where it was.
 */
export function CloseConfirm() {
  const store = useWorkspaceStore();
  const [open, setOpen] = useState(false);
  // Kept after an answer so the card doesn't empty while it fades out.
  const [warning, setWarning] = useState<CloseWarning>();
  const answer = useRef<(agreed: boolean) => void>(undefined);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(
    () =>
      store.setConfirm(
        (next) =>
          new Promise<boolean>((resolve) => {
            // A second question replaces the first, which counts as Cancel.
            answer.current?.(false);
            answer.current = resolve;
            setWarning(next);
            setOpen(true);
          }),
      ),
    [store],
  );
  useEffect(() => () => answer.current?.(false), []);
  const respond = (agreed: boolean) => {
    const resolve = answer.current;
    answer.current = undefined;
    setOpen(false);
    resolve?.(agreed);
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && respond(false)}>
      <DialogContent initialFocus={cancel} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{warning?.title}</DialogTitle>
          <DialogDescription>{warning?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={cancel} variant="ghost" onClick={() => respond(false)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => respond(true)}>
            {warning?.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
