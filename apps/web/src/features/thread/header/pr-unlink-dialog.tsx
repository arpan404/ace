import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.tsx";
import { failure } from "./use-git-flow.tsx";

export function PrUnlinkDialog(props: { onUnlink(): Promise<unknown>; onClose(): void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unlink all pull requests?</DialogTitle>
          <DialogDescription>
            The pull requests stay on GitHub. Their links will be removed from this thread.
          </DialogDescription>
        </DialogHeader>
        {error !== undefined && (
          <p role="alert" className="text-sm text-status-failed">
            {failure(error)}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={pending}
            onClick={() => {
              setPending(true);
              void props.onUnlink().then(props.onClose, (reason: unknown) => {
                setError(reason);
                setPending(false);
              });
            }}
          >
            Unlink all
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
