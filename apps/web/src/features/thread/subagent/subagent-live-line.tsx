import { useItem } from "@ace/client-react";
import type { Agent } from "@ace/protocol";
import { describeActivity, type SubagentPhase, type TurnActivity } from "@ace/ui-core";
import { useMemo } from "react";
import { ActivityLine } from "../items/live-head.tsx";

/**
 * The live line heading a running subagent's work, as a thread's turn has: "Working for
 * 1m 12s · Running bun test", or that it waits on the person. Nothing once it has ended.
 */
export function SubagentLiveLine(props: {
  threadId: string;
  agent: Agent;
  phase: SubagentPhase;
  /** Subagents of its own still running. */
  subagents: number;
}) {
  const { agent, phase } = props;
  const status = agent.status;
  const tool = useItem(
    props.threadId,
    status.state === "working" && status.itemId ? status.itemId : "",
  );
  // Its own turn over, it has no step of its own: what still runs is under it.
  const step =
    status.state === "idle"
      ? undefined
      : describeActivity(status, tool?.type === "tool_call" ? tool.call.title : undefined);
  const activity = useMemo<TurnActivity | undefined>(() => {
    if (phase === "human")
      return {
        label: "Waiting on you",
        tone: "needs-you",
        elapsedFrom: undefined,
        current: undefined,
      };
    if (phase !== "running") return undefined;
    return {
      label: "Working",
      tone: "working",
      elapsedFrom: agent.createdAt,
      current: undefined,
      subagents: props.subagents || undefined,
    };
  }, [phase, agent.createdAt, props.subagents]);
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
