import { Suspense, useEffect } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { whenIdle } from "@/lib/idle.ts";
import { MachineScope } from "@/lib/machine-scope.tsx";
import { useMachines } from "@/lib/machines.ts";
import { useTransferOpener, useTransferRequest } from "@/lib/transfer-opener.ts";

const TransferDialog = deferredComponent(() =>
  import("./transfer-dialog.tsx").then((module) => module.TransferDialog),
);

/**
 * Where "Continue on…" and "Open on…" ask which machine: mounted once in the shell, drawn only
 * after a menu has asked, and kept for its exit animation. Work on another machine's thread is
 * sent from that machine, so the chooser runs inside its scope: its links, its client.
 */
export function TransferHost() {
  const opener = useTransferOpener();
  const { request, open, opening } = useTransferRequest();
  const machines = useMachines();
  useEffect(() => whenIdle(() => void TransferDialog.preload().catch(() => {}), 6_000), []);
  if (!request) return null;
  const dialog = (
    <Suspense fallback={null}>
      <TransferDialog.Component
        key={opening}
        request={request}
        open={open}
        onClose={() => opener.close()}
      />
    </Suspense>
  );
  if (!request.hostId) return dialog;
  const machine = machines.find((each) => each.id === request.hostId);
  // A machine that went away meanwhile: nothing to send from, so nothing shows.
  if (!machine) return null;
  return <MachineScope machine={machine}>{dialog}</MachineScope>;
}
