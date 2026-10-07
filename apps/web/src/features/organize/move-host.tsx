import { Suspense, useEffect } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { whenIdle } from "@/lib/idle.ts";
import { useMoveState, useThreadMover } from "./mover.ts";

/** The project picker loads on first use, or once the browser is idle. */
const MoveDialog = deferredComponent(() =>
  import("./move-dialog.tsx").then((module) => module.MoveDialog),
);

/**
 * Where "Move to project…" asks which project: mounted once in the shell, drawn only after a
 * menu, the selection bar or the palette has asked, and kept for its exit animation.
 */
export function MoveToProjectHost() {
  const mover = useThreadMover();
  const { request, open } = useMoveState();
  useEffect(() => whenIdle(() => void MoveDialog.preload(), 4_000), []);
  if (!request) return null;
  return (
    <Suspense fallback={null}>
      <MoveDialog.Component request={request} open={open} onClose={() => mover.close()} />
    </Suspense>
  );
}
