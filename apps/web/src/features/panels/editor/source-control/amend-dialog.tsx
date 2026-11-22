import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";

/**
 * Asked before amending a commit the remote already has: amending rewrites it, so the branch then
 * needs a force push and anyone who pulled it sees history change.
 */
export function AmendDialog(props: { upstream: string; onCancel(): void; onConfirm(): void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && props.onCancel()}>
      <DialogContent material="glass">
        <DialogHeader>
          <DialogTitle>Amend a pushed commit?</DialogTitle>
          <DialogDescription>
            The last commit is already on {props.upstream}. Amending rewrites it, so pushing
            afterwards needs a force push.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button variant="danger" onClick={props.onConfirm}>
            Amend anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
