import type { AgentFacts } from "@/lib/agent-facts.ts";
import type { SidebarKey, SidebarReader } from "@ace/client";
import { useSidebar } from "@ace/client-react";
import { rollupSubagent, subagentTerminal, turnSubagents, type SubagentState } from "@ace/ui-core";
import { useAgentFacts } from "@/lib/use-agent-facts.ts";
import { useCallback, useMemo, useState } from "react";
import { useThreadLiveState } from "../lib/live-state.ts";
import {
  listedSubagentState,
  readSubagentGroup,
  subagentEntriesEqual,
  type SubagentEntry,
} from "../lib/subagent-group.ts";
import { useReceiptDelivery, useReceiptEntries } from "./receipt-entries.ts";
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
export function Subagents(props: {
  threadId: string;
  itemIds: readonly string[];
  receiptIds?: readonly string[] | undefined;
}) {
  return props.receiptIds?.length ? (
    <TurnSubagents
      threadId={props.threadId}
      itemIds={props.itemIds}
      receiptIds={props.receiptIds}
    />
  ) : (
    <Launched threadId={props.threadId} itemIds={props.itemIds} />
  );
}

function useLaunched(threadId: string, itemIds: readonly string[]): SubagentEntry[] {
  const read = useCallback(
    (facts: AgentFacts) => readSubagentGroup(facts.reader, itemIds, facts),
    [itemIds],
  );
  const own = useAgentFacts(threadId, read, subagentEntriesEqual) ?? [];
  const listed = useListedStates(own);
  return own.map((entry, at) => rolledUp(entry, listed?.[at]));
}

function Launched(props: { threadId: string; itemIds: readonly string[] }) {
  return <Group threadId={props.threadId} entries={useLaunched(props.threadId, props.itemIds)} />;
}

/** A completed turn's every subagent row as one: its launches, and the children handed it work. */
function TurnSubagents(props: {
  threadId: string;
  itemIds: readonly string[];
  receiptIds: readonly string[];
}) {
  const launched = useLaunched(props.threadId, props.itemIds);
  const delivery = useReceiptDelivery(props.threadId, props.receiptIds);
  const received = useReceiptEntries(
    props.threadId,
    delivery?.results ?? none,
    delivery?.deliveredAt,
  );
  return <Group threadId={props.threadId} entries={turnSubagents(launched, received)} />;
}

const none: readonly never[] = [];

function Group(props: { threadId: string; entries: readonly SubagentEntry[] }) {
  const { entries } = props;
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
              key={entry.childThreadId ?? entry.id}
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
