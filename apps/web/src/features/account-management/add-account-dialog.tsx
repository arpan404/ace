import type { ProviderKind } from "@ace/protocol";
import { providerNames } from "@ace/ui-core";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { AddAccountForm } from "./add-account-form.tsx";

export function AddAccountDialog(props: { provider: ProviderKind; onClose(): void }) {
  const name = providerNames[props.provider];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Add {props.provider === "opencode" ? "an" : "a"} {name} account
          </DialogTitle>
        </DialogHeader>
        <AddAccountForm provider={props.provider} name={name} onClose={props.onClose} />
      </DialogContent>
    </Dialog>
  );
}
