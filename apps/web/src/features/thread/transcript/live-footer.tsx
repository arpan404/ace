import type { ThreadReader } from "@ace/client";
import { useInteractions, useThread, useThreadMeta } from "@ace/client-react";
import { useCallback } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatClock } from "@ace/ui-core";
import { InteractionCard } from "../interactions/interaction-card.tsx";
import { agentName } from "../items/agent-row.tsx";

function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The root agent's state as one live line: "Waiting on reconnect-audit and regression-test". */
export function liveLine(reader: ThreadReader, rootId: string): string | undefined {
  const status = reader.agent(rootId)?.status;
  if (!status) return undefined;
  switch (status.state) {
    case "starting":
      return "Starting";
    case "working":
      return status.detail ?? (status.activity === "thinking" ? "Thinking" : "Working");
    case "blocked": {
      if (status.on === "human") return undefined;
      if (status.on === "subagents") {
        const names = status.refs.flatMap((id) => {
          const agent = reader.agent(id);
          return agent ? [agentName(agent)] : [];
        });
        return names.length ? `Waiting on ${list(names)}` : "Waiting on subagents";
      }
      if (status.on === "background_task") {
        const titles = status.refs.flatMap((id) => {
          const task = reader.task(id);
          return task ? [task.title] : [];
        });
        return titles.length ? `Waiting on ${list(titles)}` : "Waiting on a background task";
      }
      const until = status.until ? `, retrying at ${formatClock(status.until)}` : "";
      const reason = {
        rate_limit: "Rate limited",
        network: "Network trouble",
        upstream: "Provider unavailable",
      }[status.on];
      return `${reason}${until}`;
    }
    default:
      return undefined;
  }
}

/** Below the last block: open requests to answer, then what the agent is doing now. */
export function LiveFooter(props: { threadId: string }) {
  const pending = useInteractions(props.threadId) ?? [];
  const rootId = useThreadMeta(props.threadId)?.rootAgentId ?? "";
  const read = useCallback((reader: ThreadReader) => liveLine(reader, rootId), [rootId]);
  const line = useThread(props.threadId, ["agents", "tasks", `agent:${rootId}`], read);
  if (!pending.length && !line) return null;
  return (
    <div className="flex flex-col gap-3 pb-2">
      {pending.map((id) => (
        <InteractionCard key={id} threadId={props.threadId} interactionId={id} />
      ))}
      {line && (
        <p role="status" aria-label={line} className="flex items-center gap-[9px] text-[13.5px]">
          <Spinner />
          <span className="shimmer">{line}</span>
        </p>
      )}
    </div>
  );
}
