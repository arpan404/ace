import type { AgentFacts } from "@/lib/agent-facts.ts";
import type { SidebarKey, SidebarReader } from "@ace/client";
import { useSidebar } from "@ace/client-react";
import { rollupSubagent, subagentTerminal, type SubagentState } from "@ace/ui-core";
import { useAgentFacts } from "@/lib/use-agent-facts.ts";
import { useCallback, useMemo, useState } from "react";
import { useThreadLiveState } from "../lib/live-state.ts";
import {
  listedSubagentState,
  readSubagentGroup,
  subagentEntriesEqual,
  type SubagentEntry,
} from "../lib/subagent-group.ts";
import { SubagentFold, SubagentSection } from "./subagent-fold.tsx";
import { SubagentRow } from "./subagent-row.tsx";

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
  const live = useThreadLiveState(props.threadId);
  const [open, setOpen] = useState(false);
  if (!entries.length) return null;
  const states = entries.map((entry) => entry.state);
  const running = states.some((state) => !subagentTerminal(state));
  const [only] = entries;
  const single = running && entries.length === 1 && only;
  return (
    <SubagentSection states={states} folded={!single}>
      {single ? (
        <ul aria-label="Subagents">
          <SubagentRow threadId={props.threadId} entry={single} fresh={live.fresh} />
        </ul>
      ) : (
        <SubagentFold
          entries={entries}
          fresh={live.fresh}
          open={open}
          onToggle={() => setOpen(!open)}
        >
          {entries.map((entry) => (
            <SubagentRow
              key={entry.id}
              threadId={props.threadId}
              entry={entry}
              fresh={live.fresh}
              listed
            />
          ))}
        </SubagentFold>
      )}
    </SubagentSection>
  );
}
