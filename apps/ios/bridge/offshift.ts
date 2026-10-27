import type { ChangeTap, ThreadSource, ClientCore } from "@ace/client";
import type { ThreadId } from "@ace/protocol";
import type { OffshiftPersonOperation } from "@ace/protocol/offshift-person";
import { mobileOffshift } from "@ace/ui-core/mobile";
import { touchesTree } from "./agents.ts";
import { preview } from "./presentation.ts";

type Put = (key: string, read: () => Record<string, unknown> | undefined) => void;
export type OffshiftOwner = Pick<ClientCore, "request">;

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

/*
 * The phone's own Offshift controls over `offshift.request`, the same operations the web sends:
 * start a run, mark a step, record a check, revise a criterion, advance, clear a blocker or end
 * the run. Every change carries the card's version, so an agent write in between is refused as a
 * conflict rather than overwritten. Swift builds each `op` from `@ace/ui-core/offshift-controls`
 * and shows `offshiftFailure` when the daemon refuses it.
 */
export function requestOffshift(
  owner: OffshiftOwner,
  threadId: ThreadId,
  op: OffshiftPersonOperation,
  requestId: string,
) {
  return owner.request({ type: "offshift.request", requestId, threadId, op });
}
