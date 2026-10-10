import * as z from "zod/mini";
import type { LogLevel, LogLine, LogSource } from "./thread-log.ts";

/*
 * What a Logs tab shows of a log: an agent's subtree, a minimum level, some sources and a
 * text filter. Pure. The level and sources are kept with the tab (its `data`), so a thread's
 * Logs tab comes back filtered the way it was left.
 */

export const logSources: readonly LogSource[] = [
  "daemon",
  "session",
  "agent",
  "turn",
  "shell",
  "task",
  "input",
  "notice",
];

export const sourceLabels: Record<LogSource, string> = {
  daemon: "ace",
  session: "Sessions",
  agent: "Subagents",
  turn: "Turns",
  shell: "Shell commands",
  task: "Background work",
  input: "Questions and approvals",
  notice: "Provider notices",
};

export type LevelFilter = "all" | "warn" | "error";

export const levelLabels: Record<LevelFilter, string> = {
  all: "All levels",
  warn: "Warnings and errors",
  error: "Errors only",
};

export interface LogFilter {
  level: LevelFilter;
  /** Sources hidden from view; empty shows every source. */
  hidden: readonly LogSource[];
}

export const defaultFilter: LogFilter = { level: "all", hidden: [] };

const FilterSchema = z.object({
  level: z.catch(z.enum(["all", "warn", "error"]), "all"),
  hidden: z.catch(z.array(z.enum(logSources as [LogSource, ...LogSource[]])), []),
});

/** A tab's stored filter; anything unreadable (an older or hand-edited entry) falls back. */
export function readFilter(data: unknown): LogFilter {
  const parsed = FilterSchema.safeParse(data);
  return parsed.success ? parsed.data : defaultFilter;
}

const QuerySchema = z.object({ query: z.catch(z.string(), "") });
export function readLogQuery(data: unknown): string {
  const parsed = QuerySchema.safeParse(data);
  return parsed.success ? parsed.data.query : "";
}

const rank: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };
const minimum: Record<LevelFilter, number> = { all: 0, warn: 1, error: 2 };

/** The agent and every subagent under it. */
export function agentSubtree(
  agents: readonly { id: string; parentId: string | null }[],
  root: string,
): Set<string> {
  const subtree = new Set([root]);
  // Parents can be listed after their children: repeat until nothing more joins.
  for (let grew = true; grew;) {
    grew = false;
    for (const agent of agents)
      if (agent.parentId && subtree.has(agent.parentId) && !subtree.has(agent.id)) {
        subtree.add(agent.id);
        grew = true;
      }
  }
  return subtree;
}

/** The lines a tab shows: of `agents` if given, at or above the level, sources and text. */
export function filterLog(
  lines: readonly LogLine[],
  filter: LogFilter,
  query: string,
  agents?: ReadonlySet<string>,
): LogLine[] {
  const needle = query.trim().toLowerCase();
  const hidden = new Set(filter.hidden);
  return lines.filter(
    (line) =>
      (!agents || (line.agentId !== undefined && agents.has(line.agentId))) &&
      rank[line.level] >= minimum[filter.level] &&
      !hidden.has(line.source) &&
      (!needle || line.text.toLowerCase().includes(needle) || line.source.includes(needle)),
  );
}

/** Lines as plain text, one per line, for Copy and Save: "12:04:31  shell  $ bun run test". */
export function formatLog(lines: readonly LogLine[], time: (at: number) => string): string {
  return lines
    .map((line) => {
      const label = line.level === "info" ? line.source : line.level;
      return `${time(line.at)}  ${label.padEnd(7)}  ${line.text}`;
    })
    .join("\n");
}
