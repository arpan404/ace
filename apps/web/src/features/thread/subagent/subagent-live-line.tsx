import type { Agent } from "@ace/protocol";
import { isActivelyRunning, type SubagentPhase, type TurnActivity } from "@ace/ui-core";
import type { Live } from "@/lib/live-connection.ts";
import { useMemo } from "react";
import { ActivityLine } from "../items/live-head.tsx";

/**
 * The live line heading a running subagent's work, as a thread's turn has: "Working for
 * 1m 12s" and nothing after it, or that it has gone silent. Waiting on the person lives in the
 * bottom strip and Summary, never on this line: if the subagent itself still works while a
 * grandchild waits on the person, it keeps showing "Working for …"; otherwise it steps aside.
 * Nothing once it has ended. While the thread's copy isn't confirmed it says only that (`live`).
 */
export function SubagentLiveLine(props: {
  agent: Agent;
  phase: SubagentPhase;
  /** Subagents of its own still running. */
  subagents: number;
  /** Whether the copy is current; if not, its phase may be stale and only its words show. */
  live: Live;
}) {
  const { agent, phase, live } = props;
  const activelyWorking = isActivelyRunning(agent);
  const activity = useMemo<TurnActivity | undefined>(() => {
    if (!live.current)
      return { label: live.word, tone: "held", elapsedFrom: undefined, current: undefined };
    // Silent with nothing under it running: never "Working", no timer.
    if (phase === "stalled")
      return { label: "Not responding", tone: "held", elapsedFrom: undefined, current: undefined };
    if (phase !== "running" && !(phase === "human" && activelyWorking)) return undefined;
    return {
      label: "Working",
      tone: "working",
      elapsedFrom: agent.createdAt,
      current: undefined,
      subagents: props.subagents || undefined,
    };
  }, [live, phase, activelyWorking, agent.createdAt, props.subagents]);
  if (!activity) return null;
  return (
    <div className="py-2">
      <ActivityLine activity={activity} />
    </div>
  );
}
