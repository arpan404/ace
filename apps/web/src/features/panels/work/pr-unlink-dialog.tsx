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
import { unlinkFailureText } from "./pr-unlink.ts";

/**
 * Unlinking one pull request from the Summary list: the pull request stays on GitHub, only
 * its link to this thread goes. Follows the thread header's unlink-all dialog.
 */
export function PrUnlinkDialog(props: {
  number: number;
  onUnlink(): Promise<unknown>;
  onClose(): void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unlink pull request #{props.number}?</DialogTitle>
          <DialogDescription>
            The pull request stays on GitHub. Its link will be removed from this thread.
          </DialogDescription>
        </DialogHeader>
        {error !== undefined && (
          <p role="alert" className="text-sm text-status-failed">
            {unlinkFailureText(error)}
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
            Unlink
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
