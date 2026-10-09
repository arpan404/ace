import { MachineLabel } from "@/components/ui/machine-label.tsx";
import { GitPullRequestIcon } from "@phosphor-icons/react";
import { type ProjectBadge, type ThreadCard } from "@ace/ui-core";
import type { CSSProperties } from "react";
import { Icon } from "@/components/icon.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { LiveWorkMark } from "@/components/live-work-mark.tsx";

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
    card.pr !== undefined && `Pull request #${card.pr}`,
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
export function StatusMark(props: { card: ThreadCard }) {
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

/** The pull request, as its glyph and number. */
function PullRequest(props: { number: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      <Icon icon={GitPullRequestIcon} size={12} />
      {props.number}
    </span>
  );
}

/** Settled rows show only a pull request or their age, replaced by Unsettle on hover. */
export function RowMeta(props: { card: ThreadCard }) {
  const { card } = props;
  return (
    <span className="flex shrink-0 items-center text-xs text-subtle-foreground group-focus-within/row:hidden group-hover/row:hidden">
      {card.pr !== undefined ? (
        <PullRequest number={card.pr} />
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
  if (card.flags.settled) return "text-subtle-foreground";
  if (card.emphasis) return "font-medium text-foreground";
  return card.dimmed ? "text-muted-foreground" : "text-sidebar-foreground";
}

/** The diff as +added −removed in the only colours a row carries, or the pull request. */
function ChangeMark(props: { card: ThreadCard }) {
  const { pr, diff } = props.card;
  if (pr !== undefined) return <PullRequest number={pr} />;
  if (!diff) return null;
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      {diff.added > 0 && <span className="text-status-done">+{diff.added}</span>}
      {diff.removed > 0 && <span className="text-status-failed">−{diff.removed}</span>}
    </span>
  );
}

/** The provider's mark, with the count of subagents working beside it. */
function ProviderMark(props: { card: ThreadCard; instance?: string | undefined }) {
  const { card } = props;
  return (
    <span role="img" aria-label={card.providerLabel} className="inline-flex items-center gap-0.5">
      <ProviderAccountIcon
        instance={props.instance}
        provider={card.provider}
        acpAgentId={card.acpAgentId}
        size={16}
        decorative
      />
      {card.subagents > 0 && (
        <span className="text-2xs text-muted-foreground tabular-nums">{card.subagents}</span>
      )}
    </span>
  );
}

/** Always-visible task context; only its right-side marks give way to the hover action. */
export function RowDetail(props: { card: ThreadCard; instance?: string | undefined }) {
  const { card } = props;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate">{card.branch?.name ?? card.project}</span>
        {card.machine && (
          <>
            {" "}
            · <MachineLabel name={card.machine} icon={card.machineIcon} />
          </>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 group-focus-within/row:invisible group-hover/row:invisible">
        <ChangeMark card={card} />
        <ProviderMark card={card} instance={props.instance} />
      </span>
    </span>
  );
}
