import type { ThreadKey, ThreadReader } from "@ace/client";
import { arrayEqual, useThread } from "@ace/client-react";
import type { Item } from "@ace/protocol";
import { ScrollIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { useMemo } from "react";
import { LongRows } from "@/components/virtual-rows.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { usePanelServices } from "../services.ts";
import { useLocal } from "../store.ts";
import { showLogLines } from "./cleared.ts";
import { logEqual, threadLog, type LogLine } from "./thread-log.ts";

/** Items that can log a line. Messages and reasoning never do, so their streaming costs nothing. */
const logs = (item: Item) =>
  item.type === "tool_call" || item.type === "notice" || item.type === "compaction";

/**
 * The keys the log derives from beyond the lists themselves: every agent, task and interaction,
 * the items that can log a line and the runs of the window's turns. An item's type and run never
 * change, so this is re-read only when the lists or the order do.
 */
const readKeys = (reader: ThreadReader): ThreadKey[] => {
  const keys: ThreadKey[] = [
    ...reader.agentIds().map((id): ThreadKey => `agent:${id}`),
    ...reader.taskIds().map((id): ThreadKey => `task:${id}`),
    ...reader.interactionIds().map((id): ThreadKey => `interaction:${id}`),
  ];
  const runs = new Set<string>();
  for (const id of reader.order) {
    const item = reader.item(id);
    if (!item) continue;
    if (item.runId && !runs.has(item.runId)) {
      runs.add(item.runId);
      keys.push(`run:${item.runId}`);
    }
    if (logs(item)) keys.push(`item:${id}`);
  }
  return keys;
};
const noLines: readonly LogLine[] = [];

/**
 * The thread's log lines, live. Re-derived only when an entity that can change a line does
 * (not on every streamed message delta).
 */
export function useThreadLog(threadId: string): readonly LogLine[] {
  const followed = useThread(
    threadId,
    ["order", "agents", "tasks", "interactions"],
    readKeys,
    arrayEqual,
  );
  const keys = useMemo<ThreadKey[]>(
    () => ["thread", "order", "agents", "tasks", "interactions", ...(followed ?? [])],
    [followed],
  );
  return useThread(threadId, keys, threadLog, logEqual) ?? noLines;
}

/** Above this many lines the log mounts only those near the viewport. */
const virtualAbove = 200;
const lineHeight = 19.2;
const lineKey = (line: LogLine) => line.key;

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
  const clearedByThread = useLocal(services.logCleared, (value) => value);
  const cleared = clearedByThread.get(props.threadId);
  const shown = cleared === undefined ? lines : lines.filter((line) => !cleared.has(line.key));
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
            onClick={() => showLogLines(services.logCleared, props.threadId)}
          >
            Show
          </button>
        </p>
      )}
      <div role="list" aria-label="Thread log" className="text-muted-foreground">
        <LongRows
          items={shown}
          virtualAbove={virtualAbove}
          rowKey={lineKey}
          estimate={lineHeight}
          render={(line) => <LogRow line={line} />}
        />
      </div>
    </div>
  );
}

function LogRow(props: { line: LogLine }) {
  const { line } = props;
  return (
    <div role="listitem" className="grid grid-cols-[auto_8ch_minmax(0,1fr)] gap-x-3">
      <span className="text-subtle-foreground tabular-nums">{time.format(line.at)}</span>
      {/* Warnings and errors share the failed colour (the design's Logs); amber stays
          reserved for "needs you". */}
      <span className={cn(line.level !== "info" && "text-status-failed")}>
        {line.level === "info" ? line.source : line.level === "warn" ? "warn" : "error"}
      </span>
      <span className="break-words whitespace-pre-wrap">{line.text}</span>
    </div>
  );
}
