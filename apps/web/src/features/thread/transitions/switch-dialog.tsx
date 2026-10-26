import type { ProviderKind } from "@ace/protocol";
import { switchQuestion, type ModelChoice } from "@ace/ui-core";
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
 * Confirm moving a thread to another provider, in the shared words (`switchQuestion`). The new
 * agent reads a summary of the thread, not the old one's private working state, and the switch
 * waits for the running turn to finish. `continues`: the thread can't move in place (a Cursor
 * thread leaving Cursor or its account), so the person's next message starts a new thread with
 * this one's context instead.
 */
export function SwitchDialog(props: {
  from: ProviderKind;
  to: ModelChoice;
  busy: boolean;
  continues?: boolean | undefined;
  /** Something in the message being written that can't go to the new thread, and what to do. */
  warning?: string | undefined;
  onConfirm(): void;
  onClose(): void;
}) {
  const question = switchQuestion({
    from: props.from,
    to: props.to,
    busy: props.busy,
    continues: props.continues === true,
    warning: props.warning,
  });
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{question.title}</DialogTitle>
          <DialogDescription>{question.message}</DialogDescription>
          {question.warning && (
            <p role="alert" className="text-sm text-status-failed">
              {question.warning}
            </p>
          )}
          {question.detail && (
            <p className="min-w-0 text-sm break-words text-muted-foreground">{question.detail}</p>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="button" variant="primary" autoFocus onClick={props.onConfirm}>
            {question.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
