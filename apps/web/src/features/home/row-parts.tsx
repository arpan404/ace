import { PullRequestGlyph, pullRequestTone } from "@/components/pull-request-state.tsx";
import { type ThreadCard } from "@ace/ui-core";
import { formatSpan } from "@ace/ui-core";
import { useSeconds } from "@/lib/time.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { StatusLabel } from "@/components/status-label.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";

/*
 * Shared row pieces render the card facts. RowTime reads the shared clock for elapsed time;
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

/** The first line keeps its status word visible during hover, focus and renaming. */
export function RowStatus(props: { card: ThreadCard }) {
  const { card } = props;
  if (card.status.tone === "done" || card.status.tone === "idle") return <RowTime card={card} />;
  return (
    <StatusLabel
      tone={card.status.tone}
      label={card.status.compact}
      mark={false}
      className="gap-0 text-xs font-normal"
    />
  );
}

/** Only visible, fresh working rows subscribe to the shared second clock. */
export function RowTime(props: { card: ThreadCard }) {
  const { card } = props;
  const fresh = useLiveConnection().fresh;
  const ongoing = !card.flags.settled && card.status.tone !== "done" && card.status.tone !== "idle";
  const now = useSeconds(fresh && ongoing && card.status.since !== undefined);
  return (
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
      {ongoing && card.status.since !== undefined && fresh
        ? formatSpan(card.status.since, now)
        : card.age}
    </span>
  );
}

/** Branch and environment share the last line; the provider keeps the trailing slot. */
export function RowContext(props: { card: ThreadCard }) {
  const { card } = props;
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
      {card.branch && (
        <span className="min-w-0 flex-1 truncate font-mono" title={card.branch.name}>
          {card.branch.name}
        </span>
      )}
      {card.pr !== undefined && (
        <span className="shrink-0">
          <PullRequest card={card} />
        </span>
      )}
      {card.branch && <span aria-hidden>·</span>}
      <span
        className="flex min-w-0 max-w-[45%] items-center gap-1 truncate"
        title={card.machine ?? "This machine"}
      >
        <MachineMark icon={card.machineIcon} />
        <span className="truncate">{card.machine ?? "This machine"}</span>
      </span>
      <span
        role="img"
        aria-label={card.providerLabel}
        className="ml-auto flex shrink-0 items-center gap-1"
      >
        {card.subagents > 0 && <span className="tabular-nums">{card.subagents}</span>}
        <ProviderIcon provider={card.provider} acpAgentId={card.acpAgentId} size={14} decorative />
      </span>
    </div>
  );
}

/** Unread results and requests take priority over the canonical dimmed flag. */
export function quietCard(card: ThreadCard): boolean {
  return card.dimmed && !card.emphasis;
}

/** Selection stays readable; ordinary read work uses the quiet ink. */
export function titleTone(card: ThreadCard): string {
  return card.flags.unread || card.emphasis ? "font-medium text-foreground" : "text-foreground";
}
