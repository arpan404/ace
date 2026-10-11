import { useSidebarThread } from "@ace/client-react";
import type { AgentFacts } from "@/lib/agent-facts.ts";
import {
  delegatedState,
  describeProviderError,
  formatClock,
  resultLead,
  subagentLabels,
  subagentTerminal,
  rollupSubagent,
  type DelegationResult,
  type SubagentState,
} from "@ace/ui-core";
import { CaretRightIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/cn.ts";
import { useAgentFacts } from "@/lib/use-agent-facts.ts";
import { useCallback } from "react";
import {
  readSubagentResults,
  subagentEntriesEqual,
  type SubagentEntry,
} from "../lib/subagent-group.ts";
import { ModelFacing } from "./model-facing.tsx";
import { SubagentAvatar, subagentTones } from "./subagent-row.tsx";

const outcomes: Record<DelegationResult["outcome"], SubagentState> = {
  completed: "done",
  failed: "failed",
  cancelled: "cancelled",
};

/** Results stay at their delivery point; one compact navigable row per child. */
export function DelegationCard(props: {
  threadId: string;
  results: readonly DelegationResult[];
  received?: string;
  at?: number;
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
  return (
    <section aria-label="Delegated work finished" className="py-2">
      <ul aria-label="Subagent results" className="flex flex-col gap-1">
        {props.results.map((result) => (
          <ResultRow
            key={result.threadId}
            result={result}
            at={props.at}
            entry={byThread.get(result.threadId)}
          />
        ))}
      </ul>
      {props.received && <ModelFacing text={props.received} className="mt-2" />}
    </section>
  );
}

function ResultRow(props: {
  result: DelegationResult;
  at?: number | undefined;
  entry?: SubagentEntry | undefined;
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
  const title = props.entry?.title ?? thread?.title ?? "Delegated thread";
  const lead =
    result.outcome === "failed"
      ? describeProviderError({
          text: result.result,
          provider: thread?.provider,
          model: thread?.execution?.model,
        }).title
      : resultLead(result.result);
  const label = subagentLabels[state];
  return (
    <li>
      <Link
        to="/t/$threadId"
        params={{ threadId: result.threadId }}
        aria-label={`Open ${title}'s thread, ${label}`}
        className="flex min-h-(--row-height) pointer-coarse:min-h-11 items-center gap-(--surface-gap) rounded-md px-(--surface-inset) py-[calc(var(--setting-row-padding)/2)] transition-colors duration-(--dur-1) hover:bg-accent focus-ring"
      >
        <SubagentAvatar
          provider={props.entry?.provider ?? thread?.provider}
          model={props.entry?.model ?? thread?.execution?.model}
          state={state}
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="min-w-0 truncate text-ui font-medium">{title}</span>
            <span
              className={cn(
                "shrink-0 rounded-sm bg-secondary px-1.5 py-0.5 text-xs",
                subagentTones[state],
              )}
            >
              {label}
            </span>
          </span>
          {lead && (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">{lead}</span>
          )}
        </span>
        {props.at !== undefined && (
          <time
            dateTime={new Date(props.at).toISOString()}
            className="shrink-0 text-xs text-subtle-foreground tabular-nums"
          >
            {formatClock(props.at)}
          </time>
        )}
        <CaretRightIcon aria-hidden size={16} className="shrink-0 text-subtle-foreground" />
      </Link>
    </li>
  );
}
