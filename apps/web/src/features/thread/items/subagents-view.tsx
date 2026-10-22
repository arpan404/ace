import type { AgentFacts } from "@/lib/agent-facts.ts";
import type { SidebarKey, SidebarReader } from "@ace/client";
import { useSidebar } from "@ace/client-react";
import {
  rollupSubagent,
  subagentGroupCounts,
  subagentGroupStatus,
  subagentGroupTitle,
  subagentTerminal,
  type SubagentGroupStatus,
  type SubagentState,
} from "@ace/ui-core";
import { CaretRightIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { useAgentFacts } from "@/lib/use-agent-facts.ts";
import { useCallback, useId, useMemo, useState } from "react";
import { useThreadLiveState } from "../lib/live-state.ts";
import {
  listedSubagentState,
  readSubagentGroup,
  subagentEntriesEqual,
  type SubagentEntry,
} from "../lib/subagent-group.ts";
import { ProvidersLead } from "./agent-lead.tsx";
import { subagentTones } from "./agent-row.tsx";
import { SubagentElapsed, SubagentRow } from "./subagent-row.tsx";

const groupTones: Record<SubagentGroupStatus, string> = {
  human: "needs-you",
  failed: "failed",
  working: "working",
  done: "done",
};

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

type Listed = readonly (SubagentState | undefined)[];
const sameListed = (a: Listed, b: Listed) =>
  a.length === b.length && a.every((state, at) => state === b[at]);

/**
 * Each delegated child's state as the thread list has it (`listedSubagentState`): after a
 * reconnect it can be newer than the parent's copy on the child's launch row.
 */
function useListedStates(entries: readonly SubagentEntry[]): Listed | undefined {
  const ids = entries.map((entry) => entry.childThreadId ?? "").join("\n");
  const keys = useMemo<SidebarKey[]>(
    () => [
      "unconfirmed",
      "sync",
      "error",
      ...ids.split("\n").flatMap((id) => (id ? [`thread:${id}` as const] : [])),
    ],
    [ids],
  );
  const read = useCallback(
    (reader: SidebarReader): Listed =>
      ids.split("\n").map((id) => (id ? listedSubagentState(reader, id) : undefined)),
    [ids],
  );
  return useSidebar(keys, read, sameListed);
}

/** An entry at the worse of its own state and the list's: never ended while either says it runs. */
function rolledUp(entry: SubagentEntry, listed: SubagentState | undefined): SubagentEntry {
  const state = listed ? rollupSubagent(entry.state, listed) : entry.state;
  if (state === entry.state) return entry;
  return { ...entry, state, endedAt: subagentTerminal(state) ? entry.endedAt : undefined };
}

/**
 * A launch's subagents in the transcript. One still at work is just its row, its live activity in
 * view. Several, or any number once all have ended, fold into one row led by their providers'
 * marks: "3 subagents" with each status count in its tone while they run, "3 subagents ran" with
 * only what didn't finish once they all have, how long they ran, opening to their rows under a
 * hairline. The counts carry the state: the group reads as its worst child (needs you, failed,
 * working, done), so it never reads done while any child works or waits.
 */
export function Subagents(props: { threadId: string; itemIds: readonly string[] }) {
  const read = useCallback(
    (facts: AgentFacts) => readSubagentGroup(facts.reader, props.itemIds, facts),
    [props.itemIds],
  );
  const own = useAgentFacts(props.threadId, read, subagentEntriesEqual) ?? [];
  const listed = useListedStates(own);
  const entries = own.map((entry, at) => rolledUp(entry, listed?.[at]));
  const [open, setOpen] = useState(false);
  const body = useId();
  const live = useThreadLiveState(props.threadId);
  if (!entries.length) return null;
  const states = entries.map((entry) => entry.state);
  const running = states.some((state) => !subagentTerminal(state));
  const title = subagentGroupTitle(states);
  const [only] = entries;
  if (running && entries.length === 1 && only)
    return (
      <section aria-label={title}>
        <ul aria-label="Subagents">
          <SubagentRow threadId={props.threadId} entry={only} fresh={live.fresh} />
        </ul>
      </section>
    );
  const startedAt = Math.min(...entries.map((entry) => entry.startedAt));
  const ends = entries.flatMap((entry) => (entry.endedAt === undefined ? [] : [entry.endedAt]));
  const endedAt = !running && ends.length === entries.length ? Math.max(...ends) : undefined;
  const status = subagentGroupStatus(states);
  return (
    <section aria-label={title} data-group-status={status}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={body}
        aria-label={title}
        aria-describedby={`${body}-lead ${body}-status`}
        data-transcript-row=""
        onClick={() => setOpen(!open)}
        className={groupStyles.head}
      >
        <span id={`${body}-lead`}>
          <ProvidersLead agents={entries} />
        </span>
        <span className="min-w-0 truncate">
          <span className={groupStyles.title}>{title}</span>
          <span
            id={`${body}-status`}
            role="status"
            data-tone={groupTones[status]}
            className={groupStyles.counts}
          >
            {!live.fresh && running && "Last seen: "}
            {subagentGroupCounts(states).map((part, index) => (
              <span key={part.state}>
                {index > 0 && <span className={groupStyles.separator}> · </span>}
                <span data-tone={subagentTones[part.state]} className="text-(--tone-text)">
                  {part.count} {part.word}
                </span>
              </span>
            ))}
          </span>
        </span>
        <span className={groupStyles.time}>
          <SubagentElapsed
            startedAt={startedAt}
            endedAt={endedAt}
            running={running}
            fresh={live.fresh}
          />
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
            {entries.map((entry) => (
              <SubagentRow
                key={entry.id}
                threadId={props.threadId}
                entry={entry}
                fresh={live.fresh}
                listed
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
