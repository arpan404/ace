import { deferredComponent } from "@/lib/deferred-component.tsx";

/** An opened "Worked for" log: logs start folded, so its code loads after first paint. */
export const DeferredTurnWork = deferredComponent(() =>
  import("./turn-work.tsx").then((module) => module.TurnWork),
);
