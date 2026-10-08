import { useLiveConnection } from "@/lib/live-connection.ts";
import { GitBranchIcon, GitPullRequestIcon, MoonIcon } from "@phosphor-icons/react";
import { formatSpan, type ProjectBadge, type ThreadCard } from "@ace/ui-core";
import type { CSSProperties } from "react";
import { Icon } from "@/components/icon.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { LiveWorkMark } from "@/components/live-work-mark.tsx";
import { useSeconds } from "@/lib/time.ts";

/*
 * Pure pieces of a Home thread row. They render a `ThreadCard` view model and know nothing about
 * the client, the organizer or routing. Everything they draw is decoration: the words for it are
 * in the row's name (`threadDetails`), which nothing hides, and in its tooltip.
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
    branch?.pr !== undefined && `Pull request #${branch.pr}`,
    card.diff && `${card.diff.added} lines added, ${card.diff.removed} removed`,
    `Project ${card.project}`,
    card.flags.pinned && "Pinned",
    card.machine && `Running on ${card.machine}`,
    card.wake && `Snoozed until ${card.wake}`,
  ].filter((part): part is string => typeof part === "string" && part.length > 0);
}

/**
 * The project's two letters on a quiet tile. The open row's tile takes the project's tint
 * (`--project-<n>`, AA on every surface); only the variable is inline, the rule is shared.
 */
export function ProjectMark(props: { badge: ProjectBadge }) {
  return (
    <span
      aria-hidden
      style={{ "--tint": `var(--project-${props.badge.tint})` } as CSSProperties}
      className="inline-flex h-4 w-5 shrink-0 items-center justify-center rounded-xs bg-foreground/6 text-[9px] leading-none font-semibold tracking-[0.02em] text-subtle-foreground group-data-[status=active]/link:bg-(--tint)/16 group-data-[status=active]/link:text-(--tint)"
    >
      {props.badge.initials}
    </span>
  );
}

/**
 * The status as one small mark in its tone: a spinner while working, a dot when it needs you or
 * failed, a hollow ring while it waits on something other than the person. Nothing at rest.
 */
function StatusMark(props: { card: ThreadCard }) {
  const { card } = props;
  switch (card.status.mark) {
    case "working":
      return <LiveWorkMark />;
    case "needs-you":
    case "failed":
    case "unresponsive":
    case "limited":
      return <Dot tone={card.status.mark} />;
    case "none":
      return card.status.tone === "waiting" ? <Dot tone="limited" /> : null;
  }
}

/** "18s", "4m", "1h 2m" since work began, ticking with the shared second clock. */
function Elapsed(props: { since: number }) {
  const { fresh } = useLiveConnection();
  const now = useSeconds(fresh);
  if (!fresh) return null;
  return <span className="tabular-nums">{formatSpan(props.since, now)}</span>;
}

/** The pull request, as its glyph and number. */
function PullRequest(props: { number: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      <Icon icon={GitPullRequestIcon} size={12} />
      {props.number}
    </span>
  );
}

/**
 * The row's right end: a snooze, the pull request, the status mark, then how long it has worked
 * or how long ago it last moved. Quick actions take its place on hover and focus.
 */
export function RowMeta(props: { card: ThreadCard }) {
  const { card } = props;
  const pr = card.branch?.pr;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-subtle-foreground group-focus-within/row:hidden group-hover/row:hidden">
      {card.wake && <Icon icon={MoonIcon} size={12} />}
      {pr !== undefined && (
        <span className="group-data-[status=active]/link:hidden">
          <PullRequest number={pr} />
        </span>
      )}
      <StatusMark card={card} />
      {card.pill?.since !== undefined ? (
        <Elapsed since={card.pill.since} />
      ) : (
        <span className="tabular-nums">{card.age}</span>
      )}
    </span>
  );
}

/**
 * The title: medium and bright when it needs you or has news, quiet once the work is behind you,
 * quieter still once settled.
 */
export function titleTone(card: ThreadCard): string {
  if (card.emphasis) return "font-medium text-foreground";
  if (card.flags.settled) return "text-subtle-foreground";
  return card.dimmed ? "text-muted-foreground" : "text-sidebar-foreground";
}

/** The diff as +added −removed in the only colours a row carries, or the pull request. */
function ChangeMark(props: { card: ThreadCard }) {
  const { branch, diff } = props.card;
  if (!diff) return branch?.pr !== undefined ? <PullRequest number={branch.pr} /> : null;
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      {diff.added > 0 && <span className="text-status-done">+{diff.added}</span>}
      {diff.removed > 0 && <span className="text-status-failed">−{diff.removed}</span>}
    </span>
  );
}

/** The provider's mark, with the count of subagents working beside it. */
function ProviderMark(props: { card: ThreadCard }) {
  const { card } = props;
  return (
    <span className="inline-flex items-center gap-0.5">
      <ProviderIcon
        provider={card.provider}
        acpAgentId={card.acpAgentId}
        size={card.provider === "opencode" ? 24 : 16}
        decorative
      />
      {card.subagents > 0 && (
        <span className="text-2xs text-muted-foreground tabular-nums">{card.subagents}</span>
      )}
    </span>
  );
}

/** Branch on hover, readable changes on hover and in the open row. */
export function RowDetail(props: { card: ThreadCard }) {
  const { card } = props;
  return (
    <span
      aria-hidden
      className="hidden min-w-0 items-center gap-1.5 text-xs text-muted-foreground group-hover/row:flex group-hover/row:flex-1 group-data-[status=active]/link:flex"
    >
      <span className="hidden min-w-0 items-center gap-1 group-hover/row:flex group-hover/row:flex-1">
        {card.branch?.worktree && <Icon icon={GitBranchIcon} size={12} />}
        <span className="truncate">{card.branch?.name ?? card.machine}</span>
      </span>
      <span className="shrink-0">
        <ChangeMark card={card} />
      </span>
      <span className="hidden shrink-0 group-hover/row:mr-11 group-hover/row:inline-flex">
        <ProviderMark card={card} />
      </span>
    </span>
  );
}
