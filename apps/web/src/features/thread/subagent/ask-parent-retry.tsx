import { useClient, useItem, useThreadMeta } from "@ace/client-react";
import { ThreadId, type Agent } from "@ace/protocol";
import { agentName, retryRequest } from "@ace/ui-core";
import { ArrowCounterClockwiseIcon, CheckIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { stripControl } from "../composer/composer-styles.ts";

/** The parent is busy: what it is sent waits for its turn to end. */
const busy = new Set(["working", "waiting", "needs_you", "limited", "unresponsive"]);

/**
 * For a provider's subagent that failed or was stopped, which nobody but its parent can run
 * again: one press sends the thread's main agent a short message naming the subagent, its task
 * and how it ended, so it can relaunch it. The message queues while the parent works and starts
 * a turn when it is idle; it is only ever sent on the press, never on its own.
 */
export function AskParentRetry(props: {
  threadId: string;
  agent: Agent;
  /** The subagent's own parent is the thread's main agent. */
  direct: boolean;
}) {
  const { threadId, agent } = props;
  const client = useClient();
  const toast = useToast();
  const meta = useThreadMeta(threadId);
  const spawn = useItem(threadId, agent.spawnedBy ?? "");
  const [state, setState] = useState<"idle" | "sending" | "queued" | "sent">("idle");
  const parentBusy = meta ? busy.has(meta.status.state) : false;
  const label = props.direct ? "Ask parent to retry" : "Ask main agent to retry";
  if (state === "queued" || state === "sent")
    return (
      <span role="status" className="inline-flex h-8 shrink-0 items-center gap-1.5 px-2 text-ui">
        <CheckIcon aria-hidden size={14} className="shrink-0 text-muted-foreground" />
        <span data-slot="action-label">
          {state === "queued" ? "Queued for parent" : "Sent to parent"}
        </span>
      </span>
    );
  const send = async () => {
    setState("sending");
    const status = agent.status;
    const text = retryRequest({
      name: agentName(agent),
      task: spawn?.type === "tool_call" ? spawn.call.title : undefined,
      ended:
        status.state === "interrupted"
          ? { kind: "stopped" }
          : {
              kind: "failed",
              reason: status.state === "failed" ? status.error.message : undefined,
            },
    });
    try {
      await client.enqueue({
        type: "thread.send",
        threadId: ThreadId.parse(threadId),
        input: [{ type: "text", text }],
        trigger: "user",
        delivery: "queue",
      });
      setState(parentBusy ? "queued" : "sent");
    } catch {
      setState("idle");
      toast.error({ title: "Couldn't reach the parent" });
    }
  };
  return (
    <button
      type="button"
      disabled={state === "sending"}
      onClick={() => void send()}
      aria-label={label}
      className={cn(stripControl, "h-8 shrink-0 text-ui text-foreground")}
    >
      <ArrowCounterClockwiseIcon aria-hidden size={15} className="shrink-0" />
      <span data-slot="action-label">{label}</span>
    </button>
  );
}
