import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog.tsx";

export interface StopConfirmProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  label: string;
  stopping: boolean;
  onStop(): void;
}

/**
 * The question Stop asks before it stops an agent's subagents too: a danger confirmation, so
 * focus starts on Cancel (`DialogContent`) and returns to Stop when it closes. It loads on first
 * use, so the dialog stays out of the first paint while Stop itself draws eagerly.
 */
export function StopConfirm(props: StopConfirmProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogTitle>{props.label}?</DialogTitle>
        <DialogDescription>Their work so far stays in the thread.</DialogDescription>
        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={props.stopping} onClick={props.onStop}>
            Stop all
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
