import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.tsx";
import type { DeleteRequest } from "./delete-confirmation.ts";

export function DeleteDialog(props: { request: DeleteRequest; onClose(): void }) {
  const { request } = props;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>Delete thread?</DialogTitle>
        <DialogDescription>
          {request.title} will be permanently deleted. {request.running}
        </DialogDescription>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              props.onClose();
              request.confirm();
            }}
          >
            {request.running ? "Stop and delete" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
