import type { ThreadKey, ThreadReader } from "@ace/client";
import { arrayEqual, useItemOrder, useThread } from "@ace/client-react";
import { ScrollIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { useMemo } from "react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { usePanelServices } from "../services.ts";
import { useLocal } from "../store.ts";
import { logEqual, threadLog, type LogLine } from "./thread-log.ts";

const readIds = (reader: ThreadReader) => [
  ...reader.agentIds(),
  "\u0000",
  ...reader.taskIds(),
  "\u0000",
  ...reader.interactionIds(),
];
const noLines: readonly LogLine[] = [];

/** The thread's log lines, live. Keys cover every entity the derivation reads. */
export function useThreadLog(threadId: string): readonly LogLine[] {
  const order = useItemOrder(threadId);
  const ids = useThread(threadId, ["agents", "tasks", "interactions"], readIds, arrayEqual);
  const keys = useMemo<ThreadKey[]>(() => {
    const [agents = [], tasks = [], interactions = []] = split(ids ?? []);
    return [
      "thread",
      "order",
      "agents",
      "tasks",
      "interactions",
      ...agents.map((id): ThreadKey => `agent:${id}`),
      ...tasks.map((id): ThreadKey => `task:${id}`),
      ...interactions.map((id): ThreadKey => `interaction:${id}`),
      ...(order ?? []).map((id): ThreadKey => `item:${id}`),
    ];
  }, [ids, order]);
  return useThread(threadId, keys, threadLog, logEqual) ?? noLines;
}

function split(ids: readonly string[]): string[][] {
  const groups: string[][] = [[]];
  for (const id of ids) {
    if (id === "\u0000") groups.push([]);
    else groups.at(-1)?.push(id);
  }
  return groups;
}

const time = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Logs tab: what happened in this thread, one line per event, newest at the bottom. */
export function LogsTab(props: { threadId: string }) {
  const lines = useThreadLog(props.threadId);
  const services = usePanelServices();
  const cutoffs = useLocal(services.logCutoffs, (value) => value);
  const cutoff = cutoffs.get(props.threadId);
  const shown = cutoff === undefined ? lines : lines.filter((line) => line.at > cutoff);
  const hidden = lines.length - shown.length;
  if (!lines.length)
    return (
      <EmptyState
        icon={ScrollIcon}
        title="No logs yet"
        description="Sessions, subagents, background work and provider notices for this thread appear here."
      />
    );
  return (
    <div className="px-4 pt-3 pb-4 font-mono text-[12px] leading-[1.6]">
      {hidden > 0 && (
        <p className="pb-1 font-sans text-xs text-subtle-foreground">
          {hidden} earlier {hidden === 1 ? "line" : "lines"} cleared ·{" "}
          <button
            type="button"
            className="underline-offset-2 hover:text-foreground hover:underline"
            onClick={() =>
              services.logCutoffs.set((previous) => {
                const next = new Map(previous);
                next.delete(props.threadId);
                return next;
              })
            }
          >
            Show
          </button>
        </p>
      )}
      <ol aria-label="Thread log" className="text-muted-foreground">
        {shown.map((line) => (
          <li key={line.key} className="grid grid-cols-[auto_8ch_minmax(0,1fr)] gap-x-3">
            <span className="text-subtle-foreground tabular-nums">{time.format(line.at)}</span>
            <span
              className={cn(
                line.level === "error" && "text-status-failed",
                line.level === "warn" && "text-status-needs-you",
              )}
            >
              {line.level === "info" ? line.source : line.level === "warn" ? "warn" : "error"}
            </span>
            <span className="break-words whitespace-pre-wrap">{line.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
