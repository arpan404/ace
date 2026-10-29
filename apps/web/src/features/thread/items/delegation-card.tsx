import type { SidebarKey, SidebarReader, ThreadReader } from "@ace/client";
import { useSidebar, useThread } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import {
  describeProviderError,
  receiptEntry,
  receiptResults,
  resultLead,
  subagentTerminal,
  type DelegationResult,
} from "@ace/ui-core";
import type { AgentFacts } from "@/lib/agent-facts.ts";
import { useAgentFacts } from "@/lib/use-agent-facts.ts";
import { useCallback, useMemo, useState } from "react";
import { useThreadLiveState } from "../lib/live-state.ts";
import {
  readSubagentResults,
  subagentEntriesEqual,
  type SubagentEntry,
} from "../lib/subagent-group.ts";
import { ModelFacing } from "./model-facing.tsx";
import { SubagentFold, SubagentSection } from "./subagent-fold.tsx";
import { SubagentRow } from "./subagent-row.tsx";

type Listed = readonly (ThreadListEntry | undefined)[];
const sameListed = (a: Listed, b: Listed) =>
  a.length === b.length && a.every((entry, at) => entry === b[at]);

/** Each delivered child as the thread list has it, for children whose launch isn't loaded. */
function useListedThreads(results: readonly DelegationResult[]): Listed {
  const ids = results.map((result) => result.threadId).join("\n");
  const keys = useMemo<SidebarKey[]>(
    () => ids.split("\n").flatMap((id) => (id ? [`thread:${id}` as const] : [])),
    [ids],
  );
  const read = useCallback(
    (reader: SidebarReader): Listed => ids.split("\n").map((id) => reader.thread(id)),
    [ids],
  );
  return useSidebar(keys, read, sameListed) ?? [];
}

/**
 * Delegated work delivered back, where it arrived: one row per child while one still works,
 * else one "3 subagents ran" row with their total time, opening to each child's row with what
 * it found. A child shows whether or not its launch is loaded, so the turn reads the same at
 * any scroll position.
 */
export function DelegationCard(props: {
  threadId: string;
  results: readonly DelegationResult[];
  received?: string | undefined;
  deliveredAt?: number | undefined;
}) {
  const { results } = props;
  const read = useCallback(
    (facts: AgentFacts) =>
      readSubagentResults(facts.reader, new Set(results.map((result) => result.threadId)), facts),
    [results],
  );
  const launches = useAgentFacts(props.threadId, read, subagentEntriesEqual) ?? [];
  const listed = useListedThreads(results);
  const live = useThreadLiveState(props.threadId);
  const [open, setOpen] = useState(false);
  const byThread = new Map(launches.map((entry) => [entry.childThreadId, entry]));
  const entries: SubagentEntry[] = results.map((result, at) => {
    const thread = listed[at];
    const lead =
      result.outcome === "failed"
        ? describeProviderError({
            text: result.result,
            provider: thread?.provider,
            model: thread?.execution?.model,
          }).title
        : resultLead(result.result);
    return receiptEntry(result, byThread.get(result.threadId), thread, props.deliveredAt, lead);
  });
  if (!entries.length) return null;
  const [only] = entries;
  const single = entries.length === 1 && only && !subagentTerminal(only.state) ? only : undefined;
  const rows = (
    <SubagentSection states={entries.map((entry) => entry.state)} folded={!single}>
      {single ? (
        <ul aria-label="Subagent results" className="flex flex-col">
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
  return (
    <section aria-label="Delegated work finished">
      {rows}
      {props.received && <ModelFacing text={props.received} className="mt-2" />}
    </section>
  );
}

const sameDelivery = (a: ReturnType<typeof receiptResults>, b: ReturnType<typeof receiptResults>) =>
  a.deliveredAt === b.deliveredAt &&
  a.results.length === b.results.length &&
  a.results.every((result, at) => {
    const other = b.results[at];
    return (
      other?.threadId === result.threadId &&
      other.outcome === result.outcome &&
      other.result === result.result
    );
  });

/** Receipts delivered back to back (`mergeReceipts`), as one card. */
export function DelegationReceipts(props: { threadId: string; itemIds: readonly string[] }) {
  const keys = useMemo(() => props.itemIds.map((id) => `item:${id}` as const), [props.itemIds]);
  const read = useCallback(
    (reader: ThreadReader) => receiptResults(props.itemIds.map((id) => reader.item(id))),
    [props.itemIds],
  );
  const delivery = useThread(props.threadId, keys, read, sameDelivery);
  if (!delivery?.results.length) return null;
  return (
    <DelegationCard
      threadId={props.threadId}
      results={delivery.results}
      deliveredAt={delivery.deliveredAt}
    />
  );
}
