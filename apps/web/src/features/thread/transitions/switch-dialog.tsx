import type { ProviderKind } from "@ace/protocol";
import { accountDisplayName, providerNames, type ModelChoice } from "@ace/ui-core";
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
 * Confirm moving a thread to another provider. The new agent reads a summary of the thread, not
 * the old one's private working state, and the switch waits for the running turn to finish.
 * `continues`: the thread can't move in place (a Cursor thread leaving Cursor or its account),
 * so the person's next message starts a new thread with this one's context instead.
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
  const to = providerNames[props.to.provider];
  const from = providerNames[props.from];
  const target = props.to.account
    ? `${props.to.model} on ${accountDisplayName(props.to.account)}`
    : props.to.model;
  if (props.continues)
    return (
      <Dialog open onOpenChange={(open) => !open && props.onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Continue in a new thread?</DialogTitle>
            <DialogDescription>
              {from} keeps this conversation on its own account. Your next message starts a new
              thread on {target}, with this conversation as its context. Its files go with it. This
              thread stays as it is.
            </DialogDescription>
            {props.warning && (
              <p role="alert" className="text-sm text-status-failed">
                {props.warning}
              </p>
            )}
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="button" variant="primary" autoFocus onClick={props.onConfirm}>
              Continue on {to}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Switch to {to}?</DialogTitle>
          <DialogDescription>
            {to} picks up from a summary of this thread. What {from} kept to itself (its scratch
            state and tool sessions) doesn't carry over.
            {props.busy ? " The switch happens once the current turn finishes." : ""}
          </DialogDescription>
          <p className="min-w-0 text-sm break-words text-muted-foreground">
            Model: {props.to.model}
          </p>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="button" variant="primary" autoFocus onClick={props.onConfirm}>
            Switch to {to}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
