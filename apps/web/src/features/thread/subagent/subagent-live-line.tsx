import type { Agent } from "@ace/protocol";
import type { SubagentPhase, TurnActivity } from "@ace/ui-core";
import type { Live } from "@/lib/live-connection.ts";
import { useMemo } from "react";
import { ActivityLine } from "../items/live-head.tsx";

/**
 * The live line heading a running subagent's work, as a thread's turn has: "Working for
 * 1m 12s" and nothing after it, that it waits on the person, or that it has gone silent.
 * Nothing once it has ended. While the thread's copy isn't confirmed it says only that (`live`), as a
 * thread's own live line does: no "Working", no timer, no "Waiting on you".
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
      <ActivityLine activity={activity} />
    </div>
  );
}
