import type { ThreadReader } from "@ace/client";
import { useClient, useThread } from "@ace/client-react";
import type { SwitchSelection } from "@ace/protocol";
import { useCallback } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { failureMessage } from "@/lib/daemon-command.ts";
import { choiceKind, usePendingChoice } from "./pending-choice.ts";
import { useActiveRootRun } from "./stop-state.ts";
import { sendQueueAction } from "./use-queue.ts";

/** Where the person sent the held work from the limit strip: "Claude Code · work", "Opus". */
export interface CarryTarget {
  name: string;
  model: string;
  selection: SwitchSelection;
}

const carries = choiceKind<CarryTarget>();
const queueOf = (reader: ThreadReader) => reader.queue;

/**
 * Carrying a limited thread's held work on elsewhere (`thread.limit` `switch`): the daemon
 * switches and continues the turn in one command. `carrying` names the destination from the
 * person's pick until the turn runs there, the queue lets go, or it fails, so the strip says
 * "Continuing on Claude Code · work" instead of the old account's limit while the switch lands.
 */
export function useCarryOn(threadId: string) {
  const client = useClient();
  const toast = useToast();
  const queue = useThread(threadId, ["queue"], queueOf);
  const run = useActiveRootRun(threadId);
  const failed = useThread(threadId, ["thread"], readFailed) === true;
  const base = JSON.stringify([queue?.paused ?? null, queue?.reason ?? null, run ?? null, failed]);
  const pending = usePendingChoice(carries, threadId, base);
  const { choose } = pending;
  const carryOn = useCallback(
    (target: CarryTarget) =>
      void choose(target, () =>
        sendQueueAction(client, threadId, {
          id: "switch",
          label: `Continue on ${target.name}`,
          selection: target.selection,
        }),
      ).catch((error: unknown) =>
        toast.error({ title: "Couldn't switch", description: failureMessage(error) }),
      ),
    [choose, client, threadId, toast],
  );
  return { carrying: pending.chosen?.value, carryOn };
}

/** One field of the thread's meta: a step elsewhere in the thread doesn't re-render. */
const readFailed = (reader: ThreadReader) => reader.thread?.status.state === "failed";
