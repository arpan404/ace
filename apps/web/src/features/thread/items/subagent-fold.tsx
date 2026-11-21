import { subagentSpan, subagentTerminal, type SubagentState } from "@ace/ui-core";
import { CaretRightIcon } from "@ace/icons";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import type { SubagentEntry } from "../lib/subagent-group.ts";
import { ProvidersLead } from "./agent-lead.tsx";
import { useLive } from "@/lib/live-connection.ts";
import { subagentGroupLine } from "./live-words.ts";
import { SubagentElapsed } from "./subagent-row.tsx";

/** The group header's parts, in one place, so its look changes here alone. */
export const groupStyles = {
  head: "-mx-2 grid w-[calc(100%+--spacing(4))] grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-lg px-2 py-[7px] text-left text-ui transition-colors duration-(--motion-fast) hover:bg-hover focus-ring-inset",
  title: "font-medium text-foreground",
  counts: "ml-2 text-xs text-muted-foreground",
  separator: "text-subtle-foreground",
  time: "text-xs text-subtle-foreground tabular-nums",
  chevron: "text-subtle-foreground transition-transform duration-(--motion-fast)",
  list: "mt-1 ml-[9px] flex flex-col border-l border-border pl-4",
} as const;

/**
 * The section around a group of subagents, named and toned as its worst child. Callers keep it
 * the same element whether it holds the fold or one live row, so switching never remounts it.
 */
export function SubagentSection(props: {
  states: readonly SubagentState[];
  /** The facts are current: the section is named and toned by them, else only by its count. */
  fresh: boolean;
  folded: boolean;
  /** Its name in place of "3 subagents": what Spade calls the agents a bot started. */
  title?: string | undefined;
  children: ReactNode;
}) {
  const line = subagentGroupLine(useLive(props.fresh), props.states);
  const { status } = line;
  const title = props.title ?? line.title;
  return (
    <section aria-label={title} data-group-status={props.folded ? status : undefined}>
      {props.children}
    </section>
  );
}

/**
 * Subagents folded into one row led by their providers' marks: "3 subagents" with each status
 * count in its tone while they run, "3 subagents ran" with only what didn't finish once they all
 * have, and how long they ran together, opening to their rows (`children`) under a hairline. The
 * row reads as its worst child (needs you, failed, working, done), never done while one works.
 * Goes inside a `SubagentSection`.
 */
export function SubagentFold(props: {
  entries: readonly SubagentEntry[];
  /** The facts are current: a running group's time ticks, and no "Last seen". */
  fresh: boolean;
  /** Held by the caller, so it survives the group showing one live row for a while. */
  open: boolean;
  onToggle(): void;
  /** Its heading in place of "3 subagents" (see `SubagentSection`). */
  title?: string | undefined;
  children: ReactNode;
}) {
  const { entries } = props;
  const { open } = props;
  const body = useId();
  const states = entries.map((entry) => entry.state);
  const running = states.some((state) => !subagentTerminal(state));
  const live = useLive(props.fresh);
  // A stale group claims no state, not even that they all ran: just how many and the stale words.
  const line = subagentGroupLine(live, states);
  const { tone, word, counts } = line;
  const title = props.title ?? line.title;
  const { startedAt, endedAt } = subagentSpan(entries);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={body}
        aria-label={title}
        aria-describedby={`${body}-lead ${body}-status`}
        data-transcript-row=""
        onClick={props.onToggle}
        className={groupStyles.head}
      >
        <span id={`${body}-lead`}>
          <ProvidersLead agents={entries} />
        </span>
        <span className="min-w-0 truncate">
          <span className={groupStyles.title}>{title}</span>
          <span id={`${body}-status`} role="status" data-tone={tone} className={groupStyles.counts}>
            {word}
            {counts.map((part, index) => (
              <span key={part.state}>
                {index > 0 && <span className={groupStyles.separator}> · </span>}
                <span data-tone={part.tone} className="text-(--tone-text)">
                  {part.count} {part.word}
                </span>
              </span>
            ))}
          </span>
        </span>
        <span className={groupStyles.time}>
          {startedAt > 0 && live.current && (
            <SubagentElapsed
              startedAt={startedAt}
              endedAt={endedAt}
              running={running}
              fresh={props.fresh}
            />
          )}
        </span>
        <CaretRightIcon
          aria-hidden
          size={14}
          className={cn(groupStyles.chevron, open && "rotate-90")}
        />
      </button>
      <div id={body} hidden={!open}>
        {open && (
          <ul aria-label="Subagents" className={groupStyles.list}>
            {props.children}
          </ul>
        )}
      </div>
    </>
  );
}
