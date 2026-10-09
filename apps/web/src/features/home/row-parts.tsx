import { MachineLabel } from "@/components/ui/machine-label.tsx";
import { GitPullRequestIcon, GitMergeIcon } from "@phosphor-icons/react";
import { type ProjectBadge, type ThreadCard } from "@ace/ui-core";
import type { CSSProperties } from "react";
import { formatSpan } from "@ace/ui-core";
import { useSeconds } from "@/lib/time.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { StatusLabel } from "@/components/status-label.tsx";
import { Icon } from "@/components/icon.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { LiveWorkMark } from "@/components/live-work-mark.tsx";

/*
 * Shared row pieces render the card facts. RowStatus reads the shared clock for elapsed time;
 * the row name and tooltip keep the full wording when the visible text is shortened.
 */

/**
 * What a row says beyond its title, in words: the status, the provider and its subagents, the
 * worktree or branch, the pull request or the diff, the project, another machine, a snooze.
 * Assistive tech hears it as part of the row; the row's tooltip shows it to the pointer.
 */
export function threadDetails(card: ThreadCard): string[] {
  const branch = card.branch;
  return [
    card.status.label,
    card.providerLabel,
    branch && `${branch.worktree ? "Worktree" : "Branch"} ${branch.name}`,
    card.pr !== undefined && `Pull request #${card.pr}`,
    card.prState && `${card.prState} pull request`,
    card.diff && `${card.diff.added} lines added, ${card.diff.removed} removed`,
    `Project ${card.project}`,
    card.flags.pinned && "Pinned",
    card.machine && `Running on ${card.machine}`,
    card.wake && `Snoozed until ${card.wake}`,
  ].filter((part): part is string => typeof part === "string" && part.length > 0);
}

/**
 * The project's two letters on a quiet tile. The tile takes the project's tint
 * (`--project-<n>`, AA on every surface); only the variable is inline, the rule is shared.
 */
export function ProjectMark(props: { badge: ProjectBadge }) {
  return (
    <span
      aria-hidden
      style={{ "--tint": `var(--project-${props.badge.tint})` } as CSSProperties}
      className="inline-flex h-4 w-5 shrink-0 items-center justify-center rounded-xs bg-(--tint)/12 text-[9px] leading-none font-semibold text-(--tint)"
    >
      {props.badge.initials}
    </span>
  );
}

/**
 * The status as one small mark in its tone: a spinner while working, a dot when it needs you or
 * failed, a hollow ring while it waits on something other than the person. Nothing at rest.
 */
export function StatusMark(props: { card: ThreadCard }) {
  const { card } = props;
  switch (card.status.mark) {
    case "working":
      return (
        <span className="fx-work-pulse">
          <LiveWorkMark />
        </span>
      );
    case "needs-you":
    case "failed":
    case "unresponsive":
    case "limited":
      return <Dot tone={card.status.mark} />;
    case "none":
      return card.status.tone === "waiting" ? <Dot tone="limited" /> : null;
  }
}

/** State is also spoken, so the PR's colour is never the only clue. */
function PullRequest(props: { card: ThreadCard }) {
  const { pr, prState } = props.card;
  if (pr === undefined) return null;
  const tones = {
    open: "text-status-done",
    merged: "text-status-waiting",
    closed: "text-status-failed",
    draft: "text-subtle-foreground",
  };
  return (
    <span
      role="img"
      aria-label={`${prState ?? "Linked"} pull request #${pr}`}
      className={`inline-flex items-center gap-0.5 ${prState ? tones[prState] : ""}`}
    >
      <Icon icon={prState === "merged" ? GitMergeIcon : GitPullRequestIcon} size={12} />
      {pr}
    </span>
  );
}

/** Only visible working rows subscribe to the shared second clock. Offline facts stop ticking. */
export function RowStatus(props: { card: ThreadCard }) {
  const { card } = props;
  const fresh = useLiveConnection().fresh;
  const now = useSeconds(fresh && card.status.since !== undefined);
  if (card.flags.settled || card.status.tone === "done" || card.status.tone === "idle")
    return <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">{card.age}</span>;
  return (
    <StatusLabel
      tone={card.status.tone}
      label={card.status.compact ?? card.pill?.label ?? card.status.label}
      mark={<StatusMark card={card} />}
      className="min-w-0 max-w-[60%] shrink-0 gap-1 text-xs"
    >
      {card.status.since !== undefined && fresh && (
        <span className="tabular-nums">· {formatSpan(card.status.since, now)}</span>
      )}
    </StatusLabel>
  );
}

/** Settled rows show only a pull request or their age, replaced by Unsettle on hover. */
export function RowMeta(props: { card: ThreadCard }) {
  const { card } = props;
  return (
    <span className="flex shrink-0 items-center text-xs text-subtle-foreground group-focus-within/row:hidden group-hover/row:hidden">
      {card.pr !== undefined ? (
        <PullRequest card={card} />
      ) : (
        <span className="tabular-nums">{card.age}</span>
      )}
    </span>
  );
}

/**
 * The title: bold when unread, bright when it needs you, quiet once the work is behind you,
 * quieter still once settled.
 */
export function titleTone(card: ThreadCard): string {
  if (card.flags.settled) return "text-subtle-foreground";
  if (card.flags.unread) return "font-semibold text-foreground";
  if (card.emphasis) return "text-foreground";
  return card.dimmed ? "text-muted-foreground" : "text-sidebar-foreground";
}

/** PR and diff are independent facts; neither hides the other. */
function ChangeMark(props: { card: ThreadCard }) {
  const { diff } = props.card;
  return (
    <>
      <PullRequest card={props.card} />
      {diff && (
        <span className="inline-flex items-center gap-1 tabular-nums">
          {diff.added > 0 && <span className="text-status-done">+{diff.added}</span>}
          {diff.removed > 0 && <span className="text-status-failed">−{diff.removed}</span>}
        </span>
      )}
    </>
  );
}

/** The provider's mark, with the count of subagents working beside it. */
function ProviderMark(props: { card: ThreadCard; instance?: string | undefined }) {
  const { card } = props;
  return (
    <span role="img" aria-label={card.providerLabel} className="inline-flex items-center gap-0.5">
      {card.subagents > 0 && (
        <span className="text-2xs text-muted-foreground tabular-nums">⑂ {card.subagents}</span>
      )}
      <ProviderAccountIcon
        instance={props.instance}
        provider={card.provider}
        acpAgentId={card.acpAgentId}
        size={14}
        decorative
      />
    </span>
  );
}

/** Task context stays visible while the project-line status gives way to the hover action. */
export function RowDetail(props: { card: ThreadCard; instance?: string | undefined }) {
  const { card } = props;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {card.branch && <span className="truncate">{card.branch.name}</span>}
        {card.machine && (
          <>
            {" "}
            ·{" "}
            <MachineLabel
              name={card.machine}
              icon={card.machineIcon}
              className="shrink-0 max-w-[60%]"
            />
          </>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <ChangeMark card={card} />
        <ProviderMark card={card} instance={props.instance} />
      </span>
    </span>
  );
}
