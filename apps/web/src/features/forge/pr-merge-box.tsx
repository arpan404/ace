import type { ReactNode } from "react";
import {
  CheckCircleIcon,
  CircleDashedIcon,
  CircleIcon,
  GitMergeIcon,
  WarningCircleIcon,
  XCircleIcon,
  type Icon,
} from "@phosphor-icons/react";
import { formatAgo, prFacts, type Gate, type GateKey, type GateTone } from "@ace/ui-core";
import { useNow } from "@/lib/time.ts";
import { cn } from "@/lib/cn.ts";
import type { PrActions } from "./pr-actions.ts";
import { usePrActivityEvents } from "./pr-activity-events.ts";
import { useReviewOutcomes } from "./pr-reviewers-query.ts";
import { PrMergeLines } from "./pr-merge-lines.tsx";
import { useBlockingItems } from "./pr-attention.tsx";
import { TextAction } from "./pr-text-action.tsx";

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

/** Each tone's one filled status icon, as every list draws it. */
const icons: Record<GateTone, Icon> = {
  done: CheckCircleIcon,
  failed: XCircleIcon,
  "needs-you": WarningCircleIcon,
  working: CircleDashedIcon,
  waiting: GitMergeIcon,
  idle: CircleIcon,
};

function StatusIcon(props: { tone: GateTone; size: number; glyph?: Icon | undefined }) {
  const Glyph = props.glyph ?? icons[props.tone];
  return (
    <Glyph
      aria-hidden
      size={props.size}
      weight={props.tone === "working" || props.tone === "idle" ? "bold" : "fill"}
      data-tone={props.tone === "idle" ? undefined : props.tone}
      className={cn(
        "shrink-0",
        props.tone === "idle" ? "text-faint-foreground" : "text-(--tone-text)",
      )}
    />
  );
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
      className="ml-2"
      onClick={() => void lifecycle.apply({ kind })}
    >
      {kind === "update.merge" ? "Update branch" : "Rebase"}
    </TextAction>
  ));
}

/** The four gates on one line: each its status icon and its fact, jumping to its detail. */
function GatesLine(props: {
  gates: readonly Gate[];
  branchLoading: boolean;
  after: ReactNode;
  onSelect(key: GateKey): void;
}) {
  return (
    <nav aria-label="Merge gates" className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {props.gates.map((gate) => {
        const loading = gate.key === "branch" && props.branchLoading;
        const tone = loading ? "idle" : gate.tone;
        return (
          <span key={gate.key} className="inline-flex items-center">
            <button
              type="button"
              onClick={() => props.onSelect(gate.key)}
              aria-label={`${gate.label}: ${loading ? "checking" : gate.value}`}
              className="-mx-1 inline-flex h-6 items-center gap-1.5 rounded-sm px-1 text-xs text-muted-foreground tabular-nums transition-colors duration-(--motion-fast) focus-ring hover:text-foreground"
            >
              <StatusIcon tone={tone} size={14} />
              {loading ? "Checking the branch" : gate.value}
            </button>
            {gate.key === "branch" && gate.tone === "needs-you" && props.after}
          </span>
        );
      })}
    </nav>
  );
}

/**
 * Where the merge stands, on the Summary's one raised surface: a sentence in the colour of what
 * decides it ("2 things block the merge", "Waiting on checks", "Ready to merge"), the four gates
 * on one line under it, then what blocks the merge in its authors' words (`attention`) and the
 * branch rules and deployments. Merge itself stays in the header, in reach from every tab. A
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
  const surface = "scroll-mt-16 rounded-lg bg-surface-1";
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
      <section id="pr-merge" aria-label="Merge status" className={cn(surface, "px-4 py-3.5")}>
        <p
          data-tone={merged ? "waiting" : "failed"}
          className="flex items-center gap-2 text-ui font-medium text-(--tone-text)"
        >
          <StatusIcon tone={merged ? "waiting" : "failed"} size={18} />
          {merged
            ? `Merged into ${detail.baseBranch}${by}${when}`
            : `Closed without merging${by}${when}`}
        </p>
        {branch && <p className="mt-0.5 pl-6.5 text-xs text-muted-foreground">{branch}</p>}
      </section>
    );
  }
  const gates = prFacts({
    status: detail.status,
    reviewDecision: detail.reviewDecision,
    mergeState: actions.mergeState.state,
    baseBranch: detail.baseBranch,
    outcomes,
    local: actions.local.result,
  });
  const branchLoading = actions.mergeState.query.isPending;
  const head = headline(gates, blocking.length, detail.baseBranch, state === "draft");
  return (
    <section id="pr-merge" aria-label="Merge status" className={surface}>
      <div className="space-y-1.5 px-4 pt-3.5 pb-3">
        <p
          data-tone={head.tone === "idle" ? undefined : head.tone}
          className={cn(
            "flex items-center gap-2 text-ui font-medium",
            head.tone === "idle" ? "text-foreground" : "text-(--tone-text)",
          )}
        >
          <StatusIcon tone={head.tone} size={18} />
          {head.text}
        </p>
        <div className="pl-6.5">
          <GatesLine
            gates={gates}
            branchLoading={branchLoading}
            after={<UpdateActions actions={actions} />}
            onSelect={props.onGate}
          />
        </div>
      </div>
      <div className="border-t border-border-soft empty:hidden">{props.attention}</div>
      <PrMergeLines actions={actions} className="border-t border-border-soft px-4 py-2.5" />
    </section>
  );
}
