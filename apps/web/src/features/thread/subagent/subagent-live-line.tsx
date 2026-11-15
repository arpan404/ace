import { useItem } from "@ace/client-react";
import type { Agent } from "@ace/protocol";
import type { SubagentPhase, TurnActivity } from "@ace/ui-core";
import type { Live } from "@/lib/live-connection.ts";
import { subagentStep } from "./live-words.ts";
import { useMemo } from "react";
import { ActivityLine } from "../items/live-head.tsx";

/**
 * The live line heading a running subagent's work, as a thread's turn has: "Working for
 * 1m 12s · Running bun test", that it waits on the person, or that it has gone silent. Nothing
 * once it has ended. While the thread's copy isn't confirmed it says only that (`live`), as a
 * thread's own live line does: no "Working", no timer, no "Waiting on you".
 */
export function SubagentLiveLine(props: {
  threadId: string;
  agent: Agent;
  phase: SubagentPhase;
  /** Subagents of its own still running. */
  subagents: number;
  /** Whether the copy is current; if not, its phase may be stale and only its words show. */
  live: Live;
}) {
  const { agent, phase } = props;
  const status = agent.status;
  const tool = useItem(
    props.threadId,
    status.state === "working" && status.itemId ? status.itemId : "",
  );
  // Its own turn over, it has no step of its own: what still runs is under it.
  const { live } = props;
  const step = subagentStep(live, status, tool?.type === "tool_call" ? tool.call.title : undefined);
  const activity = useMemo<TurnActivity | undefined>(() => {
    if (!live.current)
      return { label: live.word, tone: "held", elapsedFrom: undefined, current: undefined };
    if (phase === "human")
      return {
        label: "Waiting on you",
        tone: "needs-you",
        elapsedFrom: undefined,
        current: undefined,
      };
    // Silent with nothing under it running: never "Working", no timer.
    if (phase === "stalled")
      return { label: "Not responding", tone: "held", elapsedFrom: undefined, current: undefined };
    if (phase !== "running") return undefined;
    return {
      label: "Working",
      tone: "working",
      elapsedFrom: agent.createdAt,
      current: undefined,
      subagents: props.subagents || undefined,
    };
  }, [live, phase, agent.createdAt, props.subagents]);
  if (!activity) return null;
  return (
    <div className="py-2">
      <ActivityLine
        activity={activity}
        progress={
          activity.tone === "working" && step
            ? step.charAt(0).toUpperCase() + step.slice(1)
            : undefined
        }
      />
    </div>
  );
}
