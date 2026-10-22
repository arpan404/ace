import type { MachinePool } from "@ace/client-worker/machines";
import { useEnsureMachinePool, useMachinePool } from "@/lib/machine-pool.ts";
import { readPairedMachine } from "@/boot/pair-machine.ts";
import { PairingForm } from "@/features/connect/index.ts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.tsx";

/** Pair this window with another machine; `onAdded` gets its host id once it's in the directory. */
export function AddMachine(props: { onClose(): void; onAdded?(hostId: string): void }) {
  const pool = useMachinePool();
  const ensure = useEnsureMachinePool();
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
            On the other computer, open Settings › Fleet › Pair a device with Administrator access,
            or run <code className="font-mono text-xs">ace pair read,operate,admin</code> there.
            Paste the link here; it links with every machine once it connects.
          </DialogDescription>
        </DialogHeader>
        <PairingForm
          url=""
          submitLabel="Add machine"
          renderActions={(actions) => <DialogFooter>{actions}</DialogFooter>}
          cancel={props.onClose}
          connect={async (target, remember, signal) => {
            const chosen: MachinePool | undefined = pool ?? (await ensure?.());
            if (!chosen)
              throw new Error("Couldn't open your machine directory. Reconnect and try again.");
            signal.throwIfAborted();
            const entry = await chosen.pair(target.url, () =>
              readPairedMachine(target, remember, signal),
            );
            props.onAdded?.(entry.hostId);
            props.onClose();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
