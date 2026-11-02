import type { SubagentDetailKind, SubagentState } from "@ace/ui-core";
import { subagentLabels } from "@ace/ui-core";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { AgentIcon, type AgentMark } from "./agent-lead.tsx";

/*
 * One agent as a transcript row: a subagent in a group or on its own, a delegated thread, a
 * conversation the agent started.
 *
 *   [mark 16] name · Delegated · model · effort      Running 4m
 *             Reading apps/web/src/row-parts.tsx    (what it does now, or what it found)
 *
 * The lead is a 20px box with a 16px mark, centred on the first line like every other
 * transcript row. The middle column shrinks; the status cluster never does. The meta keeps its
 * first word ("Delegated", the model, "New thread") and drops its tail first (the effort below
 * 30rem, the model below 25rem), truncating with its full text in a tooltip. The second line
 * starts at the meta's left edge and truncates the same way, so a long URL never pushes the
 * row wider. The status word carries the state in its tone. While it works the second line is
 * its live activity in foreground ink; once it ends, its one-line result, muted; when it needs
 * the person, what it waits on and Review; when it failed, why.
 */

/** Each state's status tone (`data-tone`): its words' AA hue. */
export const subagentTones: Record<SubagentState, string> = {
  working: "working",
  human: "needs-you",
  waiting: "waiting",
  queued: "idle",
  unresponsive: "unresponsive",
  failed: "failed",
  cancelled: "idle",
  done: "done",
};

/** The row's parts, in one place, so its look changes here alone. */
export const agentRowStyles = {
  /** The pressable box: the flex row, its hover wash and focus ring, bleeding 8px past the column. */
  box: "@container -mx-2 flex w-[calc(100%+--spacing(4))] min-w-0 items-start gap-2 rounded-lg px-2 py-[7px] text-left text-ui transition-colors duration-(--motion-fast) hover:bg-hover focus-ring-inset",
  /** The box inside a group's list, under its hairline: no bleed. */
  listed: "w-full mx-0",
  /** The lead: a 20px box with a 16px mark, centred on the first line like other tool rows. */
  mark: "flex h-5 min-w-5 shrink-0 items-center justify-center",
  /** The shrinking middle column: the first line and the second line share its left edge. */
  main: "flex min-w-0 flex-1 flex-col",
  first: "flex min-w-0 items-baseline gap-2 whitespace-nowrap",
  name: "min-w-0 truncate text-foreground",
  machine: "min-w-0 truncate text-xs text-subtle-foreground @max-[30rem]:hidden",
  meta: "min-w-0 truncate text-xs text-subtle-foreground",
  /** The meta's tail: the effort drops below 30rem, the model below 25rem. */
  metaEffort: "@max-[30rem]:hidden",
  metaModel: "@max-[25rem]:hidden",
  /** The status cluster: never shrinks, always right-aligned and whole. */
  state: "flex-none whitespace-nowrap text-right text-xs text-(--tone-text)",
  time: "ml-1.5 text-subtle-foreground tabular-nums",
  detail: "min-w-0 truncate text-xs text-muted-foreground",
} as const;

export type AgentDetailKind = SubagentDetailKind;

export interface AgentRowParts {
  mark: AgentMark;
  name: string;
  /** "Opus 4.7 · High", "Delegated · GPT-5.5 · High", "New thread · ace-next". */
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

/** The meta's words, keeping the first and dropping the tail as the row narrows. */
function MetaText(props: { meta: string }) {
  const parts = props.meta.split(" · ");
  const [head, ...tail] = parts;
  if (!head || tail.length === 0) {
    return (
      <span title={props.meta} className={agentRowStyles.meta}>
        {props.meta}
      </span>
    );
  }
  const last = tail[tail.length - 1];
  const middle = tail.slice(0, -1);
  return (
    <span title={props.meta} className={agentRowStyles.meta}>
      <span>{head}</span>
      {middle.map((part) => (
        <span key={part} className={agentRowStyles.metaModel}>
          {" · "}
          {part}
        </span>
      ))}
      <span className={agentRowStyles.metaEffort}>
        {" · "}
        {last}
      </span>
    </span>
  );
}

/** The row's contents, laid on whatever opens it (a link, a button). */
export function AgentRowContents(props: AgentRowParts) {
  const status = subagentLabels[props.state];
  const detailText = typeof props.detail === "string" ? props.detail : undefined;
  return (
    <>
      <span aria-hidden className={agentRowStyles.mark}>
        <AgentIcon {...props.mark} size={16} />
      </span>
      <span className={agentRowStyles.main}>
        <span className={agentRowStyles.first}>
          <span title={props.name} className={agentRowStyles.name}>
            {props.name}
          </span>
          {props.machine && (
            <span title={`on ${props.machine}`} className={agentRowStyles.machine}>
              on {props.machine}
            </span>
          )}
          {props.meta && <MetaText meta={props.meta} />}
        </span>
        <span
          data-detail={props.detailKind}
          title={detailText}
          className={cn(
            agentRowStyles.detail,
            // What a working subagent does now reads in foreground ink; its result, muted.
            props.detailKind === "live" && "text-foreground",
            !props.detail && "hidden",
          )}
        >
          {props.detail}
        </span>
      </span>
      <span data-tone={subagentTones[props.state]} className={agentRowStyles.state}>
        {props.stale ? `Last seen: ${status}` : status}
        {props.elapsed && <span className={agentRowStyles.time}>{props.elapsed}</span>}
      </span>
    </>
  );
}
