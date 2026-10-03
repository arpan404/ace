import type { ProviderKind } from "@ace/protocol";
import { providerNames, type ModelChoice } from "@ace/ui-core";
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
 */
export function SwitchDialog(props: {
  from: ProviderKind;
  to: ModelChoice;
  busy: boolean;
  onConfirm(): void;
  onClose(): void;
}) {
  const to = providerNames[props.to.provider];
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Switch to {to}?</DialogTitle>
          <DialogDescription>
            {to} picks up from a summary of this thread. What {providerNames[props.from]} kept to
            itself (its scratch state and tool sessions) doesn't carry over.
            {props.busy ? " The switch happens once the current turn finishes." : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="button" variant="primary" autoFocus onClick={props.onConfirm}>
            Switch to {props.to.model}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
