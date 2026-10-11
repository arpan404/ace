import { PullRequestGlyph, pullRequestTone } from "@/components/pull-request-state.tsx";
import { type ThreadCard } from "@ace/ui-core";
import { formatSpan } from "@ace/ui-core";
import { useSeconds } from "@/lib/time.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { StatusLabel } from "@/components/status-label.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { LiveWorkMark } from "@/components/live-work-mark.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";

/*
 * Shared row pieces render the card facts. RowStatus reads the shared clock for elapsed time;
 * the row name and tooltip keep the full wording when the visible text is shortened.
 */

/**
 * What a row says beyond its title, in words: the status, the provider and its subagents, the
 * worktree or branch, the pull request, the project, another machine, a snooze.
 * Assistive tech hears it as part of the row; the row's tooltip shows it to the pointer.
 */
export function threadDetails(card: ThreadCard): string[] {
  const branch = card.branch;
  return [
    card.status.label,
    card.providerLabel,
    branch && `${branch.worktree ? "Worktree" : "Branch"} ${branch.name}`,
    ...(card.prs?.length
      ? card.prs.map(
          (pr) => `Pull request #${pr.number}, ${pr.state}${pr.title ? `: ${pr.title}` : ""}`,
        )
      : [card.pr !== undefined && `Pull request #${card.pr}`]),
    card.prState && `${card.prState} pull request`,
    `Project ${card.project}`,
    card.flags.pinned && "Pinned",
    card.machine && `Running on ${card.machine}`,
    card.wake && `Snoozed until ${card.wake}`,
  ].filter((part): part is string => typeof part === "string" && part.length > 0);
}

export { ProjectMark } from "@/components/project-mark.tsx";

/**
 * The status as one small mark in its tone: a spinner while working, a dot when it needs you or
 * failed, a hollow ring while it waits on something other than the person. Nothing at rest.
 */
export function StatusMark(props: { card: ThreadCard; muted?: boolean }) {
  const { card } = props;
  const quiet = props.muted ? "text-subtle-foreground" : "";
  switch (card.status.mark) {
    case "working":
      return (
        <span className={props.muted ? undefined : "fx-work-pulse"}>
          <LiveWorkMark className={quiet} />
        </span>
      );
    case "needs-you":
    case "failed":
    case "unresponsive":
    case "limited":
      return (
        <Dot
          tone={card.status.mark}
          className={props.muted ? "[--tone:var(--muted-foreground)]" : ""}
        />
      );
    case "none":
      return card.status.tone === "waiting" ? (
        <Dot tone="limited" className={props.muted ? "[--tone:var(--muted-foreground)]" : ""} />
      ) : null;
  }
}

/** State is also spoken, so the PR's colour is never the only clue. */
export function PullRequest(props: { card: ThreadCard }) {
  const { pr, prState } = props.card;
  if (pr === undefined) return null;
  return (
    <Tip
      label={
        props.card.prs
          ?.map(
            (linked) =>
              `#${linked.number} · ${linked.state}${linked.title ? ` · ${linked.title}` : ""}`,
          )
          .join("\n") ?? `#${pr} · ${prState ?? "linked"}`
      }
    >
      <span
        role="img"
        aria-label={`${prState ?? "Linked"} pull request #${pr}${props.card.prs && props.card.prs.length > 1 ? `, ${props.card.prs.length - 1} more linked` : ""}`}
        className={cn("inline-flex items-center gap-0.5", prState && pullRequestTone(prState))}
      >
        <PullRequestGlyph state={prState} size={12} />#{pr}
        {(props.card.prs?.length ?? 0) > 1 && <span>+{(props.card.prs?.length ?? 1) - 1}</span>}
      </span>
    </Tip>
  );
}

/** Routine work shows only relative time; requests and failures retain their short labels. */
export function RowStatus(props: { card: ThreadCard }) {
  const { card } = props;
  const fresh = useLiveConnection().fresh;
  const ongoing = !card.flags.settled && card.status.tone !== "done" && card.status.tone !== "idle";
  const now = useSeconds(fresh && ongoing && card.status.since !== undefined);
  if (card.status.tone === "needs-you" || card.status.tone === "failed") {
    return (
      <StatusLabel
        tone={card.status.tone}
        label={card.status.compact}
        mark={false}
        className="text-xs"
      />
    );
  }
  return (
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
      {ongoing && card.status.since !== undefined && fresh
        ? formatSpan(card.status.since, now)
        : card.age}
    </span>
  );
}

/** Unread results and requests take priority over the canonical dimmed flag. */
export function quietCard(card: ThreadCard): boolean {
  return card.dimmed && !card.emphasis;
}

/** Selection stays readable; ordinary read work uses the quiet ink. */
export function titleTone(card: ThreadCard, selected: boolean): string {
  if (selected) return card.flags.unread ? "font-medium text-foreground" : "text-foreground";
  if (card.flags.unread) return "font-medium text-foreground";
  if (card.emphasis) return "text-foreground";
  return quietCard(card) ? "text-subtle-foreground" : "text-sidebar-foreground";
}
