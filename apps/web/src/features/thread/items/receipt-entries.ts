import type { SidebarKey, SidebarReader, ThreadReader } from "@ace/client";
import { useSidebar, useThread } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import {
  describeProviderError,
  receiptEntry,
  receiptResults,
  resultLead,
  type DelegationResult,
} from "@ace/ui-core";
import type { AgentFacts } from "@/lib/agent-facts.ts";
import { useAgentFacts } from "@/lib/use-agent-facts.ts";
import { useCallback, useMemo } from "react";
import {
  readSubagentResults,
  subagentEntriesEqual,
  type SubagentEntry,
} from "../lib/subagent-group.ts";

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
 * Each delivered child's row: its outcome and the first line of what it found, or why it
 * failed. A child shows whether or not its launch is loaded, so a turn reads the same at any
 * scroll position.
 */
export function useReceiptEntries(
  threadId: string,
  results: readonly DelegationResult[],
  deliveredAt: number | undefined,
): SubagentEntry[] {
  const read = useCallback(
    (facts: AgentFacts) =>
      readSubagentResults(facts.reader, new Set(results.map((result) => result.threadId)), facts),
    [results],
  );
  const launches = useAgentFacts(threadId, read, subagentEntriesEqual) ?? [];
  const listed = useListedThreads(results);
  const byThread = new Map(launches.map((entry) => [entry.childThreadId, entry]));
  return results.map((result, at) => {
    const thread = listed[at];
    const lead =
      result.outcome === "failed"
        ? describeProviderError({
            text: result.result,
            provider: thread?.provider,
            model: thread?.execution?.model,
          }).title
        : resultLead(result.result);
    return receiptEntry(result, byThread.get(result.threadId), thread, deliveredAt, lead);
  });
}

type Delivery = ReturnType<typeof receiptResults>;

const sameDelivery = (a: Delivery, b: Delivery) =>
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

/** What receipts of delegated work delivered: each child's latest result, and when. */
export function useReceiptDelivery(
  threadId: string,
  itemIds: readonly string[],
): Delivery | undefined {
  const keys = useMemo(() => itemIds.map((id) => `item:${id}` as const), [itemIds]);
  const read = useCallback(
    (reader: ThreadReader) => receiptResults(itemIds.map((id) => reader.item(id))),
    [itemIds],
  );
  return useThread(threadId, keys, read, sameDelivery);
}
