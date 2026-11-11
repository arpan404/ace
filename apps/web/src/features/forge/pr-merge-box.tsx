import type { ReactNode } from "react";
import {
  formatAgo,
  prFacts,
  prGates,
  type Gate,
  type GateKey,
  type GateTone,
  type MergeMethod,
} from "@ace/ui-core";
import { useNow } from "@/lib/time.ts";
import { cn } from "@/lib/cn.ts";
import type { PrActions } from "./pr-actions.ts";
import { usePrActivityEvents } from "./pr-activity-events.ts";
import { useReviewOutcomes } from "./pr-reviewers-query.ts";
import { PrMergeLines } from "./pr-merge-lines.tsx";
import { useBlockingItems } from "./pr-attention.tsx";
import { TextAction } from "./pr-text-action.tsx";
import { SummarySection, summaryCard } from "./pr-summary-section.tsx";

const methodWords: Record<MergeMethod, string> = {
  squash: "Squash",
  merge: "Merge",
  rebase: "Rebase",
};

/** How a finished PR ended, from its activity: who and when, and what became of the branch. */
function useEnding(actions: PrActions) {
  const { detail, workspaceId } = actions.context;
  const finished = detail.status.state === "merged" || detail.status.state === "closed";
  // Only a finished PR reads its activity here; an open one never waits on it.
  const activity = usePrActivityEvents({ workspaceId, detail, enabled: finished });
  const now = useNow();
  // A history still arriving may lack the ending; wait for all of it.
  if (!finished || !activity.data?.complete) return { ended: undefined, branchDeleted: undefined };
  const events = activity.data.events;
  const end = events.findLast((event) => event.event === detail.status.state);
  const at = end?.at ? Date.parse(end.at) : NaN;
  return {
    ended: end
      ? { by: end.actor, ago: Number.isFinite(at) ? formatAgo(at, now) : undefined }
      : undefined,
    branchDeleted: events.some((event) => event.event === "head_ref_deleted"),
  };
}

const things = (count: number) => `${count} ${count === 1 ? "thing blocks" : "things block"}`;

/** The panel's one sentence: where the merge stands, in the tone of what decides it. */
function headline(
  gates: readonly Gate[],
  blocking: number,
  base: string,
  draft: boolean,
): { tone: GateTone; text: string } {
  const tone = (key: GateKey) => gates.find((gate) => gate.key === key)?.tone;
  const failed = gates.filter((gate) => gate.tone === "failed").length;
  if (blocking || failed)
    return { tone: "failed", text: `${things(Math.max(blocking, failed))} the merge` };
  if (draft) return { tone: "idle", text: "Draft · mark it ready when it is" };
  if (tone("checks") === "working") return { tone: "working", text: "Waiting on checks" };
  if (tone("reviews") === "needs-you")
    return { tone: "needs-you", text: "Waiting for an approving review" };
  if (tone("branch") === "needs-you") return { tone: "needs-you", text: `Behind ${base}` };
  if (tone("conflicts") === "working") return { tone: "working", text: "Checking for conflicts" };
  return { tone: "done", text: "Ready to merge" };
}

/** Update · Rebase after "Behind main", where GitHub lets this account bring the branch up. */
function UpdateActions(props: { actions: PrActions }) {
  const { lifecycle } = props.actions;
  const updates = (["update.merge", "update.rebase"] as const).filter(lifecycle.can);
  return updates.map((kind) => (
    <TextAction
      key={kind}
      strong={kind === "update.merge"}
      disabled={lifecycle.blocked}
      className="mr-3"
      onClick={() => void lifecycle.apply({ kind })}
    >
      {kind === "update.merge" ? "Update branch" : "Rebase"}
    </TextAction>
  ));
}

/**
 * The four gates as labelled cells between hairlines, four across or two by two in a narrow
 * column: the gate's name, then its fact, in the failed colour when it blocks. Each jumps to
 * its detail.
 */
function GateCells(props: {
  gates: readonly Gate[];
  branchLoading: boolean;
  after: ReactNode;
  onSelect(key: GateKey): void;
}) {
  return (
    <nav
      aria-label="Merge gates"
      className="grid grid-cols-2 border-t border-border-soft @min-[40rem]/pr:grid-cols-4 [&>*]:border-border-soft @max-[40rem]/pr:[&>*:nth-child(n+3)]:border-t @max-[40rem]/pr:[&>*:nth-child(even)]:border-l @min-[40rem]/pr:[&>*+*]:border-l"
    >
      {props.gates.map((gate) => {
        const loading = gate.key === "branch" && props.branchLoading;
        const tone = loading ? "idle" : gate.tone;
        const loud = tone === "failed" || tone === "needs-you";
        return (
          <div key={gate.key} className="flex min-w-0 flex-col">
            <button
              type="button"
              onClick={() => props.onSelect(gate.key)}
              aria-label={`${gate.label}: ${loading ? "checking" : gate.value}`}
              className="flex min-w-0 flex-col px-4 pt-2.5 pb-1 text-left transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover"
            >
              <span className="text-xs text-subtle-foreground">{gate.label}</span>
              <span
                data-tone={loud ? tone : undefined}
                className={cn(
                  "truncate text-ui font-medium tabular-nums",
                  loud ? "text-(--tone-text)" : "text-foreground",
                )}
              >
                {loading ? "Checking…" : gate.value}
              </span>
            </button>
            <div className="flex min-h-2 flex-wrap px-4 pb-2">
              {gate.key === "branch" && gate.tone === "needs-you" && props.after}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

/**
 * The Summary's Merge status: how and into what it merges beside the heading, then one card with
 * a sentence in the colour of what decides it ("3 things block the merge", "Waiting on checks",
 * "Ready to merge"), the four gates as cells, what blocks the merge in its authors' words
 * (`attention`), and the branch rules and deployments. Merge itself stays in the header, in reach from every tab. A
 * finished PR says how it ended.
 */
export function PrMergeBox(props: {
  actions: PrActions;
  /** What blocks the merge (`PrAttention`); nothing when nothing does. */
  attention?: ReactNode;
  onGate(key: GateKey): void;
}) {
  const { actions } = props;
  const { detail, workspaceId } = actions.context;
  const outcomes = useReviewOutcomes(workspaceId, detail);
  const { ended, branchDeleted } = useEnding(actions);
  const blocking = useBlockingItems(detail);
  const state = detail.status.state;
  if (state === "unknown") return null;
  if (state === "merged" || state === "closed") {
    const merged = state === "merged";
    const by = ended?.by ? ` by ${ended.by}` : "";
    const when = ended?.ago ? ` ${ended.ago}` : "";
    const branch =
      branchDeleted === undefined
        ? ""
        : branchDeleted
          ? "The branch was deleted"
          : "The branch was kept";
    return (
      <SummarySection id="pr-merge" title="Merge status">
        <div className={cn(summaryCard, "px-4 py-3")}>
          <p
            data-tone={merged ? "waiting" : "failed"}
            className="text-md font-semibold text-(--tone-text)"
          >
            {merged
              ? `Merged into ${detail.baseBranch}${by}${when}`
              : `Closed without merging${by}${when}`}
          </p>
          {branch && <p className="mt-0.5 text-ui text-muted-foreground">{branch}</p>}
        </div>
      </SummarySection>
    );
  }
  const facts = {
    status: detail.status,
    reviewDecision: detail.reviewDecision,
    mergeState: actions.mergeState.state,
    baseBranch: detail.baseBranch,
    outcomes,
    local: actions.local.result,
  };
  // The headline weighs the sentences; the cells say the short words.
  const sentences = prFacts(facts);
  // Checks read best counted ("1 of 4 checks failing"); the rest in their short words.
  const checks = sentences.find((fact) => fact.key === "checks")?.value;
  const cells: Gate[] = prGates(facts).map((gate) =>
    gate.key === "checks" && checks ? Object.assign({}, gate, { value: checks }) : gate,
  );
  const branchLoading = actions.mergeState.query.isPending;
  const head = headline(sentences, blocking.length, detail.baseBranch, state === "draft");
  return (
    <SummarySection
      id="pr-merge"
      title="Merge status"
      right={
        <span className="px-1.5 text-ui">
          {`${methodWords[actions.method]} into `}
          <span className="font-mono text-xs text-foreground/90">{detail.baseBranch}</span>
        </span>
      }
    >
      <div className={summaryCard}>
        <p
          data-tone={head.tone === "idle" ? undefined : head.tone}
          className={cn(
            "px-4 py-3 text-md font-semibold",
            head.tone === "idle" ? "text-foreground" : "text-(--tone-text)",
          )}
        >
          {head.text}
        </p>
        <GateCells
          gates={cells}
          branchLoading={branchLoading}
          after={<UpdateActions actions={actions} />}
          onSelect={props.onGate}
        />
        <div className="border-t border-border-soft empty:hidden">{props.attention}</div>
        <PrMergeLines actions={actions} className="border-t border-border-soft px-4 py-2.5" />
      </div>
    </SummarySection>
  );
}
