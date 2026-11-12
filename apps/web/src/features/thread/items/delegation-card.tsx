import { subagentTerminal, type DelegationResult } from "@ace/ui-core";
import { useState } from "react";
import { useThreadLiveState } from "../lib/live-state.ts";
import { ModelFacing } from "./model-facing.tsx";
import { useReceiptDelivery, useReceiptEntries } from "./receipt-entries.ts";
import { SubagentFold, SubagentSection } from "./subagent-fold.tsx";
import { SubagentRow } from "./subagent-row.tsx";

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
  const entries = useReceiptEntries(props.threadId, props.results, props.deliveredAt);
  const live = useThreadLiveState(props.threadId);
  const [open, setOpen] = useState(false);
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

/** Receipts delivered back to back (`mergeReceipts`), as one card. */
export function DelegationReceipts(props: { threadId: string; itemIds: readonly string[] }) {
  const delivery = useReceiptDelivery(props.threadId, props.itemIds);
  if (!delivery?.results.length) return null;
  return (
    <DelegationCard
      threadId={props.threadId}
      results={delivery.results}
      deliveredAt={delivery.deliveredAt}
    />
  );
}
