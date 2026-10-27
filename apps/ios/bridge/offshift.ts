import type { ChangeTap, ThreadSource } from "@ace/client";
import { mobileOffshift } from "@ace/ui-core/mobile";
import { touchesTree } from "./agents.ts";
import { preview } from "./presentation.ts";

type Put = (key: string, read: () => Record<string, unknown> | undefined) => void;

/**
 * The open thread's Offshift run (`mobileOffshift`): sent when the run's card changes and when
 * the tree around it does, since the run's word depends on the whole tree. Null once the thread
 * has no run, so the thread's menu offers it only while there is one.
 */
export function followOffshift(store: ThreadSource, put: Put): ChangeTap {
  const send = () =>
    put("offshift", () => {
      const run = mobileOffshift(store);
      if (!run) return { type: "thread.offshift", run: null };
      return {
        type: "thread.offshift",
        run: {
          ...run,
          outcome: preview(run.outcome, 1024),
          blocker: run.blocker === undefined ? null : preview(run.blocker, 1024),
          next: run.next === null ? null : preview(run.next, 1024),
          endpoint: preview(run.endpoint, 512),
          steps: run.steps.map((step) => ({
            id: step.id,
            title: step.title,
            state: step.state,
            reason: step.reason ?? null,
          })),
        },
      };
    });
  send();
  return (keys) => {
    if (keys === "all" || keys.has("offshift") || keys.has("thread") || touchesTree(keys)) send();
  };
}
