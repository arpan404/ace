import type { ReactNode } from "react";
import {
  CheckIcon,
  CircleIcon,
  GitMergeIcon,
  HourglassMediumIcon,
  WarningIcon,
  XIcon,
  type Icon,
} from "@phosphor-icons/react";
import { formatAgo, prFacts, prGates, type Gate, type GateKey } from "@ace/ui-core";
import { Button } from "@/components/ui/button.tsx";
import { useNow } from "@/lib/time.ts";
import { cn } from "@/lib/cn.ts";
import type { PrActions } from "./pr-actions.ts";
import { usePrActivityEvents } from "./pr-activity-events.ts";
import { useReviewOutcomes } from "./pr-reviewers-query.ts";
import { PrMergeLines } from "./pr-merge-lines.tsx";

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

const glyphs: Record<Gate["tone"], Icon> = {
  done: CheckIcon,
  failed: XIcon,
  "needs-you": WarningIcon,
  working: HourglassMediumIcon,
  waiting: GitMergeIcon,
  idle: CircleIcon,
};

/** The gate's state as a small tinted disc with its glyph, in the status colour. */
function ToneMark(props: { tone: Gate["tone"]; glyph?: Icon | undefined }) {
  const Glyph = props.glyph ?? glyphs[props.tone];
  return (
    <span
      aria-hidden
      data-tone={props.tone === "idle" ? undefined : props.tone}
      className={cn(
        "mt-px grid size-6 shrink-0 place-items-center rounded-full",
        props.tone === "idle"
          ? "bg-fill text-subtle-foreground"
          : "bg-[color-mix(in_oklab,var(--tone)_18%,transparent)] text-(--tone-text)",
      )}
    >
      <Glyph size={13} weight="bold" />
    </span>
  );
}

/** A gate's heading as GitHub words it, from its key and tone; the fact is the line under it. */
function gateHeading(gate: Gate, base: string): { title: string; sub?: string | undefined } {
  if (gate.key === "checks")
    return gate.tone === "failed"
      ? { title: "Some checks were not successful", sub: gate.value }
      : gate.tone === "working"
        ? { title: "Some checks haven't completed yet", sub: gate.value }
        : gate.tone === "done"
          ? { title: "All checks have passed", sub: gate.value }
          : { title: gate.value };
  if (gate.key === "reviews")
    return gate.tone === "failed"
      ? { title: "Changes requested", sub: gate.value }
      : gate.tone === "done"
        ? { title: "Changes approved", sub: gate.value }
        : gate.tone === "needs-you"
          ? { title: "Review required", sub: "An approving review is required to merge." }
          : { title: "No reviews yet", sub: "Ask someone to review it from Reviewers." };
  if (gate.key === "conflicts")
    return gate.tone === "failed"
      ? { title: "This branch has conflicts that must be resolved", sub: gate.value }
      : gate.tone === "done"
        ? { title: "This branch has no conflicts with the base branch" }
        : { title: "Checking for conflicts…" };
  return gate.tone === "needs-you"
    ? {
        title: "This branch is out-of-date with the base branch",
        sub: `Bring the latest changes from ${base} into this branch.`,
      }
    : { title: gate.value };
}

/**
 * One section of the box: its mark, its heading, a line, its actions. With `onSelect` the
 * heading jumps to the gate's detail; without it (how a finished PR ended) it is words.
 */
function GateRow(props: {
  gate: Gate;
  heading: { title: string; sub?: string | undefined };
  loading?: boolean | undefined;
  action?: ReactNode;
  onSelect?: ((key: GateKey) => void) | undefined;
}) {
  const { gate } = props;
  const onSelect = props.onSelect;
  const title = props.loading ? "Checking the branch…" : props.heading.title;
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <ToneMark tone={props.loading ? "idle" : gate.tone} />
      <div className="min-w-0 flex-1">
        {onSelect ? (
          <button
            type="button"
            onClick={() => onSelect(gate.key)}
            aria-label={`${gate.label}: ${props.loading ? "checking" : gate.value}`}
            className="rounded-xs text-left text-ui font-semibold text-foreground focus-ring hover:underline"
          >
            {title}
          </button>
        ) : (
          <p className="text-ui font-semibold text-foreground">{title}</p>
        )}
        {props.heading.sub && !props.loading && (
          <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">{props.heading.sub}</p>
        )}
      </div>
      {props.action && <div className="flex shrink-0 items-center gap-1.5">{props.action}</div>}
    </li>
  );
}

/** Update branch / Update with rebase, where GitHub lets this account bring the branch up. */
function UpdateButtons(props: { actions: PrActions }) {
  const { lifecycle } = props.actions;
  const updates = (["update.merge", "update.rebase"] as const).filter(lifecycle.can);
  return updates.map((kind) => (
    <Button
      key={kind}
      size="xs"
      variant={kind === "update.merge" ? "secondary" : "ghost"}
      disabled={lifecycle.blocked}
      onClick={() => void lifecycle.apply({ kind })}
    >
      {kind === "update.merge" ? "Update branch" : "Update with rebase"}
    </Button>
  ));
}

/**
 * The merge box, as GitHub keeps it at the foot of a pull request: one bordered box saying
 * what blocks the merge in its authors' words (`attention`), then each gate as a section (checks,
 * reviews, conflicts, the branch) with its mark, its heading and a line, then the branch rules
 * and deployments. Merge itself stays in the header, in reach from every tab. A finished PR says
 * how it ended.
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
  const facts = {
    status: detail.status,
    reviewDecision: detail.reviewDecision,
    mergeState: actions.mergeState.state,
    baseBranch: detail.baseBranch,
    outcomes,
    ended,
    branchDeleted,
    local: actions.local.result,
  };
  const state = detail.status.state;
  if (state === "unknown") return null;
  if (state === "merged" || state === "closed") {
    const merged = state === "merged";
    const [end] = prGates(facts);
    const by = ended?.by ? ` by ${ended.by}` : "";
    const when = ended?.ago ? ` ${ended.ago}` : "";
    const branch =
      branchDeleted === undefined ? "" : branchDeleted ? " · branch deleted" : " · branch kept";
    return (
      <section
        id="pr-merge"
        aria-label="Merge status"
        className="scroll-mt-16 rounded-lg border border-border"
      >
        <ul>
          {end && (
            <GateRow
              gate={end}
              heading={{
                title: merged
                  ? "Pull request successfully merged and closed"
                  : "Pull request closed",
                sub: `${merged ? "Merged" : "Closed"}${by}${when}${merged ? ` into ${detail.baseBranch}` : ""}${branch}`,
              }}
            />
          )}
        </ul>
      </section>
    );
  }
  const gates = prFacts(facts);
  const branchLoading = actions.mergeState.query.isPending;
  const shown = gates.filter(
    (gate) => gate.key !== "branch" || branchLoading || gate.tone === "needs-you",
  );
  return (
    <section
      id="pr-merge"
      aria-label="Merge status"
      className="scroll-mt-16 overflow-hidden rounded-lg border border-border"
    >
      <div className="border-b border-border empty:hidden">{props.attention}</div>
      <nav aria-label="Merge gates">
        <ul className="divide-y divide-border-soft">
          {shown.map((gate) => (
            <GateRow
              key={gate.key}
              gate={gate}
              heading={gateHeading(gate, detail.baseBranch)}
              loading={gate.key === "branch" && branchLoading}
              onSelect={props.onGate}
              action={
                gate.key === "branch" && gate.tone === "needs-you" ? (
                  <UpdateButtons actions={actions} />
                ) : undefined
              }
            />
          ))}
        </ul>
      </nav>
      <PrMergeLines actions={actions} className="border-t border-border-soft px-4 py-2.5" />
    </section>
  );
}
