import type { SubagentState } from "@ace/ui-core";
import { subagentLabels } from "@ace/ui-core";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { AgentIcon, type AgentMark } from "./agent-lead.tsx";

/*
 * One agent as a transcript row: a subagent in a group or on its own, a delegated thread, a
 * conversation the agent started.
 *
 *   [mark 18] name · model, effort                     Running 4m
 *             Reading apps/web/src/row-parts.tsx    (what it does now, or what it found)
 *
 * The mark spans both lines; the status word carries the state in its tone. While it works the
 * second line is its live activity, swept by a quiet shimmer; once it ends, its one-line result;
 * when it needs the person, what it waits on and Review; when it failed, why.
 */

/** Each state's status tone (`data-tone`): its words' AA hue. */
export const subagentTones: Record<SubagentState, string> = {
  working: "working",
  human: "needs-you",
  waiting: "waiting",
  unresponsive: "unresponsive",
  failed: "failed",
  cancelled: "idle",
  done: "done",
};

/** The row's parts, in one place, so its look changes here alone. */
export const agentRowStyles = {
  /** The pressable box: the grid, its hover wash and focus ring, bleeding 8px past the column. */
  box: "-mx-2 grid w-[calc(100%+--spacing(4))] grid-cols-[18px_minmax(0,1fr)_auto] gap-x-2.5 gap-y-px rounded-lg px-2 py-[7px] text-left text-ui transition-colors duration-(--motion-fast) hover:bg-hover focus-ring-inset",
  /** The box inside a group's list, under its hairline: no bleed. */
  listed: "w-full mx-0",
  mark: "row-span-2 mt-px self-start",
  first: "flex min-w-0 items-baseline gap-2",
  name: "min-w-0 truncate text-foreground",
  meta: "shrink-0 truncate text-xs text-subtle-foreground",
  state: "text-right text-[12.5px] whitespace-nowrap text-(--tone-text)",
  time: "ml-1.5 text-subtle-foreground tabular-nums",
  detail: "col-span-2 min-w-0 truncate text-[12.5px] text-muted-foreground",
} as const;

export type AgentDetailKind = "live" | "result" | "human" | "failed";

export interface AgentRowParts {
  mark: AgentMark;
  name: string;
  /** "Opus 4.7 · High", "Delegated · Codex", "New thread · ace-next". */
  meta?: string | undefined;
  /** Where it runs, when that is another machine. */
  machine?: string | undefined;
  state: SubagentState;
  /** The state is last seen: ace lost touch with the thread. */
  stale: boolean;
  elapsed?: ReactNode;
  /** The second line, and what it says. */
  detail?: ReactNode;
  detailKind?: AgentDetailKind | undefined;
}

/** The row's contents, laid on whatever opens it (a link, a button). */
export function AgentRowContents(props: AgentRowParts) {
  const status = subagentLabels[props.state];
  return (
    <>
      <AgentIcon {...props.mark} size={18} className={agentRowStyles.mark} />
      <span className={agentRowStyles.first}>
        <span className={agentRowStyles.name}>{props.name}</span>
        {props.machine && <span className={agentRowStyles.meta}>on {props.machine}</span>}
        {props.meta && <span className={agentRowStyles.meta}>{props.meta}</span>}
      </span>
      <span data-tone={subagentTones[props.state]} className={agentRowStyles.state}>
        {props.stale ? `Last seen: ${status}` : status}
        {props.elapsed && <span className={agentRowStyles.time}>{props.elapsed}</span>}
      </span>
      <span
        data-detail={props.detailKind}
        className={cn(
          agentRowStyles.detail,
          props.detailKind === "live" && "agent-shimmer",
          !props.detail && "hidden",
        )}
      >
        {props.detail}
      </span>
    </>
  );
}
