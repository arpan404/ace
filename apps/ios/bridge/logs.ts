import type { ChangeTap, ThreadSource } from "@ace/client";
import { agentName } from "@ace/ui-core";
import {
  agentSubtree,
  defaultFilter,
  filterLog,
  formatLog,
  sourceLabels,
  type LogFilter,
} from "@ace/ui-core/log-filter";
import { threadLog, type LogLine } from "@ace/ui-core/thread-log";
import { z } from "zod";
import type { Item } from "@ace/protocol";
import type { PatchSink, Preview } from "./agents.ts";

/*
 * The thread's Logs on the phone, as the web's Logs tab: the thread's operational log (sessions,
 * subagents, turns, shell commands and exit codes, background work, questions, provider
 * notices) or one agent with the subagents under it, filtered by level, source and text. The
 * lines are the shared `threadLog`; the newest page shows first and Show earlier reads the next.
 * Re-derived only when something that can log a line changes, never on streamed text.
 */

export const LogsQuery = z.object({
  /** One agent and its subagents; null is the whole thread. */
  agentId: z.string().min(1).max(256).nullable().default(null),
  level: z.enum(["all", "warn", "error"]).default("all"),
  hidden: z
    .array(z.enum(["daemon", "session", "agent", "turn", "shell", "task", "input", "notice"]))
    .max(8)
    .default([]),
  query: z.string().max(256).default(""),
});
export type LogsQuery = z.infer<typeof LogsQuery>;

/** Lines per page: a few screens, so a long log never crosses the bridge at once. */
export const logPage = 200;

const key = "thread:logs";
/**
 * What of an item a log line reads: a tool call's status, end and exit code (never its streamed
 * output), or a notice's words. Undefined for items that log nothing.
 */
function logged(item: Item | undefined): string | undefined {
  if (item?.type === "tool_call") {
    const { call } = item;
    const exit = call.detail.kind === "shell" ? call.detail.exitCode : undefined;
    return `${call.status}|${call.endedAt ?? ""}|${exit ?? ""}|${call.backgroundTaskId ?? ""}`;
  }
  if (item?.type === "notice") return `${item.level}|${item.text}`;
  if (item?.type === "compaction") return "compaction";
  return undefined;
}

export interface LogsFollow {
  stop(): void;
  query(next: LogsQuery): void;
  earlier(): void;
  /** The shown lines as plain text, for Copy: "2:04 PM  shell    $ bun run test". */
  copy(): string;
}

export function followLogs(
  store: ThreadSource,
  threadId: string,
  epoch: number,
  sink: PatchSink,
  preview: Preview,
  time: (at: number) => string,
  initial: LogsQuery,
  page = logPage,
): LogsFollow {
  let query = initial;
  /**
   * Once Show earlier was used, the first line shown, by key: new lines arriving at the end
   * never push it off the top. Undefined shows the newest page.
   */
  let anchor: string | undefined;
  let lines: LogLine[] = [];
  let dirty = true;
  /** What each loggable item last read as, so streamed output never rebuilds the log. */
  const seen = new Map<string, string>();
  const filtered = () => {
    if (dirty) {
      lines = threadLog(store);
      dirty = false;
      // What every item read as for these lines, so only a later change rebuilds them.
      for (const id of store.order) {
        const facts = logged(store.item(id));
        if (facts !== undefined) seen.set(id, facts);
      }
    }
    const filter: LogFilter = { ...defaultFilter, level: query.level, hidden: query.hidden };
    const agents = query.agentId ? agentSubtree(agentList(), query.agentId) : undefined;
    return filterLog(lines, filter, query.query, agents);
  };
  const agentList = () =>
    store.agentIds().flatMap((id) => {
      const agent = store.agent(id);
      return agent ? [{ id, parentId: agent.parentId }] : [];
    });
  const put = () =>
    sink.put(key, () => {
      const shown = filtered();
      const start = firstShown(shown);
      const root = store.thread?.rootAgentId;
      const scope = query.agentId ? store.agent(query.agentId) : undefined;
      return {
        type: "logs.sheet",
        threadId,
        epoch,
        scope: query,
        scopeName: scope ? preview(agentName(scope), 128) : null,
        lines: shown.slice(start).map((line) => ({
          key: line.key,
          at: line.at,
          source: line.source,
          sourceLabel: sourceLabels[line.source],
          level: line.level,
          text: preview(line.text, 1024),
        })),
        earlier: start,
        total: shown.length,
        all: lines.length,
        sources: Object.entries(sourceLabels).map(([id, label]) => ({ id, label })),
        agents: store.agentIds().flatMap((id) => {
          const agent = store.agent(id);
          if (!agent) return [];
          return [
            {
              id,
              name: preview(id === root ? "Main agent" : agentName(agent), 128),
              parentId: agent.parentId,
            },
          ];
        }),
      };
    });
  /** Where the shown lines start: the anchor once set, else the newest page. */
  const firstShown = (shown: readonly LogLine[]) => {
    const at = anchor === undefined ? -1 : shown.findIndex((line) => line.key === anchor);
    if (at >= 0) return at;
    // Its line left the loaded history: keep the oldest still loaded rather than jump ahead.
    return anchor === undefined ? Math.max(0, shown.length - page) : 0;
  };
  /** True when the item's logged facts changed (or it is new); remembers them. */
  const moved = (id: string) => {
    const now = logged(store.item(id));
    if (now === undefined) return false;
    if (seen.get(id) === now) return false;
    seen.set(id, now);
    return true;
  };
  const change: ChangeTap = (keys) => {
    if (keys === "all") {
      dirty = true;
      put();
      return;
    }
    for (const changed of keys)
      if (
        changed === "order" ||
        changed === "thread" ||
        changed === "agents" ||
        changed === "tasks" ||
        changed === "interactions" ||
        changed.startsWith("agent:") ||
        changed.startsWith("task:") ||
        changed.startsWith("interaction:") ||
        changed.startsWith("run:") ||
        (changed.startsWith("item:") && moved(changed.slice(5)))
      ) {
        dirty = true;
        put();
        return;
      }
  };
  const stop = store.observe(change);
  put();
  return {
    stop: () => {
      stop();
      sink.clear(key);
    },
    query: (next) => {
      query = next;
      anchor = undefined;
      put();
    },
    earlier: () => {
      const shown = filtered();
      anchor = shown[Math.max(0, firstShown(shown) - page)]?.key;
      put();
    },
    copy: () => {
      const shown = filtered();
      return formatLog(shown.slice(firstShown(shown)), time);
    },
  };
}
