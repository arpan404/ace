import type { ThreadReader } from "@ace/client";
import { useInteractions, useThread, useThreadMeta } from "@ace/client-react";
import { useCallback } from "react";
import type { ThreadStatus } from "@ace/protocol";
import { HourglassMediumIcon } from "@phosphor-icons/react";
import { agentName, formatClock, limitHoldShown } from "@ace/ui-core";
import { Icon } from "@/components/icon.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { InteractionCard } from "../interactions/interaction-card.tsx";

function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * One live line. `working` lines move (spinner, shimmer); `held` lines wait on something outside
 * the agent (a rate limit, the network, the provider) and stay still.
 */
export interface LiveLine {
  text: string;
  tone: "working" | "held";
}

const working = (text: string): LiveLine => ({ text, tone: "working" });

/**
 * The root agent's state as one live line: "Waiting on reconnect-audit and regression-test".
 * `threadStatus` lets a rate limit stay quiet while the queue banner already explains it.
 */
export function liveLine(
  reader: ThreadReader,
  rootId: string,
  threadStatus?: ThreadStatus,
): LiveLine | undefined {
  const status = reader.agent(rootId)?.status;
  if (!status) return undefined;
  switch (status.state) {
    case "starting":
      return working("Starting");
    case "working":
      return working(status.detail ?? (status.activity === "thinking" ? "Thinking" : "Working"));
    case "blocked": {
      if (status.on === "human") return undefined;
      if (status.on === "subagents") {
        const names = status.refs.flatMap((id) => {
          const agent = reader.agent(id);
          return agent ? [agentName(agent)] : [];
        });
        return working(names.length ? `Waiting on ${list(names)}` : "Waiting on subagents");
      }
      if (status.on === "background_task") {
        const titles = status.refs.flatMap((id) => {
          const task = reader.task(id);
          return task ? [task.title] : [];
        });
        return working(
          titles.length ? `Waiting on ${list(titles)}` : "Waiting on a background task",
        );
      }
      if (status.on === "rate_limit" && limitHoldShown(threadStatus, reader.queue))
        return undefined;
      const until = status.until ? `, retrying at ${formatClock(status.until)}` : "";
      const reason = {
        rate_limit: "Rate limited",
        network: "Network trouble",
        upstream: "Provider unavailable",
      }[status.on];
      return { text: `${reason}${until}`, tone: "held" };
    }
    default:
      return undefined;
  }
}

const sameLine = (a: LiveLine | undefined, b: LiveLine | undefined) =>
  a?.text === b?.text && a?.tone === b?.tone;

/** The root agent is mid-turn and doing the work itself (not blocked or waiting). */
export function useRootWorking(threadId: string): boolean {
  const rootId = useThreadMeta(threadId)?.rootAgentId ?? "";
  const read = useCallback(
    (reader: ThreadReader) => reader.agent(rootId)?.status.state === "working",
    [rootId],
  );
  return useThread(threadId, [`agent:${rootId}`], read) ?? false;
}

/**
 * Below the last block: open requests to answer, then what the agent is doing now. `quiet`
 * drops a plain "Working" line when the work log above already says "Working for …".
 */
export function LiveFooter(props: { threadId: string; quiet?: boolean }) {
  const pending = useInteractions(props.threadId) ?? [];
  const meta = useThreadMeta(props.threadId);
  const rootId = meta?.rootAgentId ?? "";
  const status = meta?.status;
  const read = useCallback(
    (reader: ThreadReader) => liveLine(reader, rootId, status),
    [rootId, status],
  );
  const live = useThread(
    props.threadId,
    ["agents", "tasks", "queue", `agent:${rootId}`],
    read,
    sameLine,
  );
  const line = props.quiet && live?.tone === "working" ? undefined : live;
  if (!pending.length && !line) return null;
  return (
    <div className="flex flex-col gap-3 pb-2">
      {pending.map((id) => (
        <InteractionCard key={id} threadId={props.threadId} interactionId={id} />
      ))}
      {line && (
        <p
          role="status"
          aria-label={line.text}
          className="fx-view-in flex items-center gap-[9px] text-[13.5px]"
        >
          {line.tone === "working" ? (
            <>
              <Spinner />
              <span className="shimmer">{line.text}</span>
            </>
          ) : (
            <>
              <Icon icon={HourglassMediumIcon} size={14} className="text-subtle-foreground" />
              <span className="text-muted-foreground">{line.text}</span>
            </>
          )}
        </p>
      )}
    </div>
  );
}
