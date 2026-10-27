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
const loggable = new Set(["tool_call", "notice", "compaction"]);

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
): LogsFollow {
  let query = initial;
  let pages = 1;
  let lines: LogLine[] = [];
  let dirty = true;
  const filtered = () => {
    if (dirty) {
      lines = threadLog(store);
      dirty = false;
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
      const start = Math.max(0, shown.length - pages * logPage);
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
        (changed.startsWith("item:") && loggable.has(store.item(changed.slice(5))?.type ?? ""))
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
      pages = 1;
      put();
    },
    earlier: () => {
      pages++;
      put();
    },
    copy: () => {
      const shown = filtered();
      return formatLog(shown.slice(Math.max(0, shown.length - pages * logPage)), time);
    },
  };
}
