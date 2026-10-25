import { Suspense, useEffect } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { whenIdle } from "@/lib/idle.ts";
import { MachineScope } from "@/lib/machine-scope.tsx";
import { useMachines } from "@/lib/machines.ts";
import { useMoveState, useThreadMover } from "./mover.ts";

/** The project picker loads on first use, or once the browser is idle. */
const MoveDialog = deferredComponent(() =>
  import("./move-dialog.tsx").then((module) => module.MoveDialog),
);

/**
 * Where "Move to project…" asks which project: mounted once in the shell, drawn only after a
 * menu, the selection bar or the palette has asked, and kept for its exit animation. Threads on
 * another machine are moved there: the picker runs in that machine's scope, listing its projects.
 */
export function MoveToProjectHost() {
  const mover = useThreadMover();
  const { request, open } = useMoveState();
  const machines = useMachines();
  useEffect(() => whenIdle(() => void MoveDialog.preload().catch(() => {}), 4_000), []);
  if (!request) return null;
  const dialog = (
    <Suspense fallback={null}>
      <MoveDialog.Component request={request} open={open} onClose={() => mover.close()} />
    </Suspense>
  );
  if (!request.hostId) return dialog;
  const machine = machines.find((each) => each.id === request.hostId);
  // A machine that went away meanwhile: nothing to move on, so nothing shows.
  if (!machine) return null;
  return <MachineScope machine={machine}>{dialog}</MachineScope>;
}
