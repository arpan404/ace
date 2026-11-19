/*
 * The delegated-elsewhere page renders a whole `ThreadView` (transcript, composer, header), which a
 * provider's own subagent never draws. Imported statically it would load the full thread screen
 * with every subagent page, so its code loads only when a subagent opens with `?on=<hostId>`.
 */
import { Suspense } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";

const Deferred = deferredComponent(() =>
  import("./delegated-elsewhere-view.tsx").then((module) => module.DelegatedElsewhereView),
);

/** A thread ace delegated to another machine, as its parent's subagent; its code loads on use. */
export function DelegatedElsewhereView(props: {
  parentThreadId: string;
  threadId: string;
  /** The host id of the machine the child runs on. */
  machine: string;
}) {
  return (
    <Suspense fallback={null}>
      <Deferred.Component {...props} />
    </Suspense>
  );
}
