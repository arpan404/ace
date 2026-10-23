import { useSidebarThread } from "@ace/client-react";
import type { AgentFacts } from "@/lib/agent-facts.ts";
import {
  delegatedState,
  describeProviderError,
  resultLead,
  subagentTerminal,
  rollupSubagent,
  type DelegationResult,
  type SubagentState,
} from "@ace/ui-core";
import { useAgentFacts } from "@/lib/use-agent-facts.ts";
import { useCallback } from "react";
import {
  readSubagentResults,
  subagentEntriesEqual,
  type SubagentEntry,
} from "../lib/subagent-group.ts";
import { ModelFacing } from "./model-facing.tsx";
import { useThreadLiveState } from "../lib/live-state.ts";
import { SubagentRow } from "./subagent-row.tsx";

const outcomes: Record<DelegationResult["outcome"], SubagentState> = {
  completed: "done",
  failed: "failed",
  cancelled: "cancelled",
};

/** Results stay at their delivery point; one compact navigable row per child. */
export function DelegationCard(props: {
  threadId: string;
  results: readonly DelegationResult[];
  received?: string | undefined;
}) {
  const read = useCallback(
    (facts: AgentFacts) =>
      readSubagentResults(
        facts.reader,
        new Set(props.results.map((result) => result.threadId)),
        facts,
      ),
    [props.results],
  );
  const entries = useAgentFacts(props.threadId, read, subagentEntriesEqual) ?? [];
  const byThread = new Map(entries.map((entry) => [entry.childThreadId, entry]));
  const live = useThreadLiveState(props.threadId);
  return (
    <section aria-label="Delegated work finished">
      <ul aria-label="Subagent results" className="flex flex-col">
        {props.results.map((result) => (
          <ResultRow
            key={result.threadId}
            threadId={props.threadId}
            result={result}
            entry={byThread.get(result.threadId)}
            fresh={live.fresh}
          />
        ))}
      </ul>
      {props.received && <ModelFacing text={props.received} className="mt-2" />}
    </section>
  );
}

function ResultRow(props: {
  threadId: string;
  result: DelegationResult;
  entry?: SubagentEntry | undefined;
  fresh: boolean;
}) {
  const { result } = props;
  const thread = useSidebarThread(result.threadId);
  const sidebarState = thread ? delegatedState(thread.status) : undefined;
  const current =
    props.entry && sidebarState
      ? rollupSubagent(props.entry.state, sidebarState)
      : (props.entry?.state ?? sidebarState);
  // A revived child tree is live again, even though this delivery is in history.
  const state = current && !subagentTerminal(current) ? current : outcomes[result.outcome];
  const lead =
    result.outcome === "failed"
      ? describeProviderError({
          text: result.result,
          provider: thread?.provider,
          model: thread?.execution?.model,
        }).title
      : resultLead(result.result);
  const entry: SubagentEntry = {
    ...props.entry,
    id: props.entry?.id ?? result.threadId,
    // The row opens the child's thread and keeps its delivered result in view, not its activity.
    agentId: undefined,
    childThreadId: result.threadId,
    provider: props.entry?.provider ?? thread?.provider,
    model: props.entry?.model ?? thread?.execution?.model,
    title: props.entry?.title ?? thread?.title ?? "Delegated thread",
    state,
    startedAt: props.entry?.startedAt ?? 0,
    result: lead || undefined,
  };
  return <SubagentRow threadId={props.threadId} entry={entry} fresh={props.fresh} />;
}
