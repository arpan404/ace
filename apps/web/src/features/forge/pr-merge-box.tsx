import type { ComponentProps, ReactNode } from "react";
import {
  CheckIcon,
  ExclamationMarkIcon,
  GitMergeIcon,
  HourglassMediumIcon,
  XIcon,
  type Icon,
} from "@phosphor-icons/react";
import {
  can,
  formatAgo,
  prFacts,
  prGates,
  type Gate,
  type GateKey,
  type GateTone,
} from "@ace/ui-core";
import { Button } from "@/components/ui/button.tsx";
import { useNow } from "@/lib/time.ts";
import { cn } from "@/lib/cn.ts";
import type { PrActions } from "./pr-actions.ts";
import { usePrActivityEvents } from "./pr-activity-events.ts";
import { useReviewOutcomes } from "./pr-reviewers-query.ts";
import { PrMergeLines } from "./pr-merge-lines.tsx";
import { PrAttention, useBlockingItems } from "./pr-attention.tsx";
import { prBox, prBoxFoot } from "./pr-box.tsx";

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

const glyphs: Record<GateTone, Icon> = {
  done: CheckIcon,
  failed: XIcon,
  "needs-you": ExclamationMarkIcon,
  working: HourglassMediumIcon,
  waiting: GitMergeIcon,
  idle: CheckIcon,
};

/** A section's mark: a solid disc in the state's colour with its glyph on it. */
function Mark(props: { tone: GateTone; glyph?: Icon | undefined }) {
  const Glyph = props.glyph ?? glyphs[props.tone];
  return (
    <span
      aria-hidden
      data-tone={props.tone === "idle" ? undefined : props.tone}
      className={cn(
        "mt-px grid size-5.5 shrink-0 place-items-center rounded-full text-background",
        props.tone === "idle" ? "bg-subtle-foreground" : "bg-(--tone)",
      )}
    >
      <Glyph size={12} weight="bold" />
    </span>
  );
}

/** One section of the box: its mark, a heading that jumps to the gate, a line, then more. */
function Section(props: {
  tone: GateTone;
  glyph?: Icon | undefined;
  title: string;
  sub?: string | undefined;
  /** The gate it opens, named for assistive tech; without it the heading is words. */
  gate?: { key: GateKey; label: string } | undefined;
  onSelect?: ((key: GateKey) => void) | undefined;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const { gate, onSelect } = props;
  return (
    <div className="flex gap-3 px-4 py-3.5">
      <Mark tone={props.tone} glyph={props.glyph} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            {gate && onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(gate.key)}
                aria-label={gate.label}
                className="rounded-xs text-left text-ui font-semibold text-foreground focus-ring hover:underline"
              >
                {props.title}
              </button>
            ) : (
              <p className="text-ui font-semibold text-foreground">{props.title}</p>
            )}
            {props.sub && <p className="text-ui text-muted-foreground">{props.sub}</p>}
          </div>
          {props.action && <div className="flex shrink-0 gap-1.5">{props.action}</div>}
        </div>
        {props.children}
      </div>
    </div>
  );
}

/** Update branch · Update with rebase, where GitHub lets this account bring the branch up. */
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

/** "1 failing and 3 successful checks", from the checks' own counts. */
function checksLine(status: PrActions["context"]["detail"]["status"]): string {
  const count = (state: string) => status.checks.filter((c) => c.status === state).length;
  const failed = count("failure");
  const running = count("pending");
  const ok = count("success");
  const parts = [
    failed && `${failed} failing`,
    running && `${running} running`,
    ok && `${ok} successful`,
  ].filter(Boolean);
  if (!parts.length) return "";
  const last = parts.pop();
  return `${parts.length ? `${parts.join(", ")} and ${last}` : last} ${status.checks.length === 1 ? "check" : "checks"}`;
}

/**
 * The merge box, GitHub's way: one box with a section per gate. Reviews say whether changes
 * were asked for, with the asks and open conversations under it; checks say whether they
 * passed, with the failing ones under it; then conflicts and how fresh the branch is (with
 * Update), the branch rules and deployments, and a foot saying whether it can merge. Merge
 * itself is in the header, in reach from every tab. A finished PR says how it ended.
 */
export function PrMergeBox(props: {
  actions: PrActions;
  /** What the blocking rows need: the PR's workspace, the task it's for, its tabs. */
  attention: Omit<ComponentProps<typeof PrAttention>, "only" | "detail">;
  onGate(key: GateKey): void;
}) {
  const { actions } = props;
  const { detail, workspaceId } = actions.context;
  const outcomes = useReviewOutcomes(workspaceId, detail);
  const { ended, branchDeleted } = useEnding(actions);
  const blocking = useBlockingItems(detail);
  const state = detail.status.state;
  // A host that can't merge here (a read-only review) has no merge box to show.
  if (state === "unknown" || !can(detail, "reviews.merge")) return null;
  if (state === "merged" || state === "closed") {
    const merged = state === "merged";
    const by = ended?.by ? ` by ${ended.by}` : "";
    const when = ended?.ago ? ` ${ended.ago}` : "";
    const branch =
      branchDeleted === undefined ? "" : branchDeleted ? " · branch deleted" : " · branch kept";
    return (
      <section id="pr-merge" aria-label="Merge status" className={cn(prBox, "scroll-mt-16")}>
        <Section
          tone={merged ? "waiting" : "failed"}
          glyph={merged ? GitMergeIcon : XIcon}
          title={merged ? "Pull request merged" : "Pull request closed"}
          sub={`${merged ? `Merged into ${detail.baseBranch}` : "Closed without merging"}${by}${when}${branch}`}
        />
      </section>
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
  const short = new Map(prGates(facts).map((gate) => [gate.key, gate]));
  const said = new Map(prFacts(facts).map((gate) => [gate.key, gate]));
  const gate = (key: GateKey): Gate | undefined => short.get(key);
  const label = (key: GateKey) => {
    const g = gate(key);
    return g ? `${g.label}: ${g.value}` : key;
  };
  const reviews = gate("reviews");
  const checks = gate("checks");
  const conflicts = gate("conflicts");
  const branch = gate("branch");
  const hasReviewItems = blocking.some((item) => item.kind !== "check");
  const hasCheckItems = blocking.some((item) => item.kind === "check");
  const reviewsTone = reviews?.tone === "idle" ? "idle" : (reviews?.tone ?? "idle");
  const reviewsHead =
    reviews?.tone === "failed"
      ? { title: "Changes requested", sub: `${said.get("reviews")?.value ?? ""}.` }
      : reviews?.tone === "done"
        ? { title: "Changes approved", sub: `${said.get("reviews")?.value ?? ""}.` }
        : reviews?.tone === "needs-you"
          ? { title: "Review required", sub: "An approving review is required to merge." }
          : { title: "No reviews yet", sub: undefined };
  const checksHead =
    checks?.tone === "failed"
      ? "Some checks were not successful"
      : checks?.tone === "working"
        ? "Some checks haven't finished"
        : checks?.tone === "done"
          ? "All checks have passed"
          : (said.get("checks")?.value ?? "No checks");
  const branchLoading = actions.mergeState.query.isPending;
  const behind = branch?.tone === "needs-you";
  const conflicted = conflicts?.tone === "failed";
  const blocked = actions.primary.kind === "blocked";
  return (
    <section id="pr-merge" aria-label="Merge status" className={cn(prBox, "scroll-mt-16")}>
      <nav aria-label="Merge gates" className="divide-y divide-border-soft">
        {reviews && (
          <Section
            tone={hasReviewItems && reviewsTone !== "failed" ? "needs-you" : reviewsTone}
            title={reviewsHead.title}
            sub={reviewsHead.sub}
            gate={{ key: "reviews", label: label("reviews") }}
            onSelect={props.onGate}
          >
            {hasReviewItems && <PrAttention {...props.attention} detail={detail} only="reviews" />}
          </Section>
        )}
        {checks && (
          <Section
            tone={checks.tone}
            title={checksHead}
            sub={checksLine(detail.status) || undefined}
            gate={{ key: "checks", label: label("checks") }}
            onSelect={props.onGate}
          >
            {hasCheckItems && <PrAttention {...props.attention} detail={detail} only="checks" />}
          </Section>
        )}
        {conflicts && (
          <Section
            tone={conflicted ? "failed" : behind ? "needs-you" : conflicts.tone}
            title={
              conflicted
                ? "This branch has conflicts that must be resolved"
                : conflicts.tone === "working"
                  ? "Checking for conflicts…"
                  : behind
                    ? "This branch is out of date with the base branch"
                    : "No conflicts with the base branch"
            }
            sub={
              conflicted
                ? `Conflicts with ${detail.baseBranch}.`
                : behind
                  ? `Bring the latest changes from ${detail.baseBranch} into this branch.`
                  : branchLoading
                    ? undefined
                    : branch?.tone === "done"
                      ? `Up to date with ${detail.baseBranch}.`
                      : undefined
            }
            gate={{ key: "conflicts", label: label("conflicts") }}
            onSelect={props.onGate}
            action={behind ? <UpdateButtons actions={actions} /> : undefined}
          />
        )}
      </nav>
      <PrMergeLines actions={actions} className="border-t border-border-soft px-4 py-2.5" />
      <div className={prBoxFoot}>
        <span className={cn("text-ui", blocked ? "text-muted-foreground" : "text-foreground")}>
          {blocked
            ? "Merging is blocked"
            : actions.primaryBlocked
              ? actions.primaryBlocked.split("\n")[0]
              : `Ready to merge into ${detail.baseBranch}`}
        </span>
      </div>
    </section>
  );
}
