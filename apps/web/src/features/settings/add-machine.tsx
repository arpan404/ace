import type { MachinePool } from "@ace/client-worker/machines";
import { useEnsureMachinePool, useMachinePool } from "@/lib/machine-pool.ts";
import { readPairedMachine } from "@/boot/pair-machine.ts";
import { PairingForm } from "@/features/connect/index.ts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.tsx";
import { useToast } from "@/components/ui/toast.tsx";

export function AddMachine(props: { onClose(): void }) {
  const pool = useMachinePool();
  const ensure = useEnsureMachinePool();
  const toast = useToast();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add machine</DialogTitle>
          <DialogDescription>
            Create a pairing link in Settings on the other computer, then paste it here.
          </DialogDescription>
        </DialogHeader>
        <PairingForm
          url=""
          submitLabel="Add machine"
          cancel={props.onClose}
          connect={async (target, remember, signal) => {
            const chosen: MachinePool | undefined = pool ?? (await ensure?.());
            if (!chosen)
              throw new Error("Couldn't open your machine directory. Reconnect and try again.");
            signal.throwIfAborted();
            const entry = await chosen.pair(target.url, () =>
              readPairedMachine(target, remember, signal),
            );
            toast.add({ title: `${entry.displayName} added` });
            props.onClose();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
