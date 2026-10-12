import { PullRequestGlyph, pullRequestTone } from "@/components/pull-request-state.tsx";
import { providerDisplayName, type ThreadCard } from "@ace/ui-core";
import { formatSpan } from "@ace/ui-core";
import { useSeconds } from "@/lib/time.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { StatusLabel } from "@/components/status-label.tsx";
import {
  CheckCircleIcon,
  ChatCircleDotsIcon,
  HandPalmIcon,
  HourglassIcon,
  PauseCircleIcon,
  WarningDiamondIcon,
  WifiSlashIcon,
  MinusIcon,
} from "@phosphor-icons/react";
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

/** Each status pairs a distinct shape with a visible word in the status tone. */
export function StatusMark(props: { card: ThreadCard }) {
  const { status } = props.card;
  const icon = { "aria-hidden": true, size: 14, className: "shrink-0" } as const;
  if (status.mark === "unresponsive") return <WifiSlashIcon {...icon} />;
  if (status.mark === "limited") return <PauseCircleIcon {...icon} />;
  if (status.tone === "failed") return <WarningDiamondIcon {...icon} />;
  if (status.tone === "needs-you")
    return status.compact === "Answer" ? (
      <ChatCircleDotsIcon {...icon} />
    ) : (
      <HandPalmIcon {...icon} />
    );
  if (status.compact === "Waiting" || status.tone === "waiting") return <HourglassIcon {...icon} />;
  if (status.tone === "working") return <LiveWorkMark className="text-(--tone-text)" />;
  if (status.tone === "done") return <CheckCircleIcon {...icon} />;
  return <MinusIcon {...icon} />;
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

/** The first line keeps its status word visible during hover, focus and renaming. */
export function RowStatus(props: { card: ThreadCard }) {
  return (
    <StatusLabel
      tone={props.card.status.tone}
      label={props.card.status.compact}
      mark={<StatusMark card={props.card} />}
      className="min-w-0 gap-1 text-xs"
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

/** Activity, git context, running children and time use list facts without fetching history. */
export function RowContext(props: { card: ThreadCard }) {
  const { card } = props;
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
      <span className="min-w-0 flex-1 truncate" title={card.status.label}>
        {card.status.label === card.status.compact
          ? `${card.status.label} · ${providerDisplayName(card.provider, card.acpAgentId)}`
          : card.status.label}
      </span>
      {card.branch && (
        <span className="min-w-0 max-w-[35%] truncate" title={card.branch.name}>
          {card.branch.label}
        </span>
      )}
      <PullRequest card={card} />
      {card.subagents > 0 && (
        <span
          className="shrink-0"
          aria-label={`${card.subagents} ${card.subagents === 1 ? "subagent" : "subagents"} running`}
        >
          ⑂ {card.subagents}
        </span>
      )}
      <RowTime card={card} />
    </div>
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
