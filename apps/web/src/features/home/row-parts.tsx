import {
  CheckCircleIcon,
  ClockIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  MoonIcon,
  PushPinIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { formatSpan, type ProjectBadge, type TaskPill, type ThreadCard } from "@ace/ui-core";
import type { CSSProperties, ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { useSeconds } from "@/lib/time.ts";

/*
 * Pure pieces of a Home task row. They render a `ThreadCard` view model and know nothing about
 * the client, the organizer or routing. Everything they draw is decoration: the words for it are
 * in the row's name (`threadDetails`), which nothing hides.
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
 * Two letters in the project's tint (`--project-<n>`, AA on every surface) on a wash of it. The
 * tint is per project, so only the variable is inline; the rule is shared.
 */
export function ProjectMark(props: { badge: ProjectBadge; className?: string }) {
  return (
    <span
      aria-hidden
      style={{ "--tint": `var(--project-${props.badge.tint})` } as CSSProperties}
      className={cn(
        "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-[4px] bg-(--tint)/16 px-[3px] text-[9px] leading-none font-semibold tracking-[0.02em] text-(--tint)",
        props.className,
      )}
    >
      {props.badge.initials}
    </span>
  );
}

// Tinted tones share one mix rule and each names its status colour in a small class of its own.
const tinted = "text-[color-mix(in_oklab,var(--tone)_85%,var(--foreground))]";
const pillTone: Record<TaskPill["tone"], string> = {
  working: `${tinted} [--tone:var(--status-working)]`,
  "needs-you":
    "rounded-full bg-status-needs-you/13 px-1.5 text-[color-mix(in_oklab,var(--status-needs-you)_80%,var(--foreground))]",
  waiting: `${tinted} [--tone:var(--status-waiting)]`,
  failed: `${tinted} [--tone:var(--status-failed)]`,
  done: `${tinted} [--tone:var(--status-done)]`,
  idle: "text-muted-foreground",
};

function PillIcon(props: { pill: TaskPill }) {
  switch (props.pill.icon) {
    case "working":
      return <Spinner className="text-current" />;
    case "needs-you":
      return <Dot tone="needs-you" />;
    case "waiting":
      return <Icon icon={ClockIcon} size={13} />;
    case "done":
      return <Icon icon={CheckCircleIcon} size={13} />;
    case "failed":
      return <Icon icon={WarningCircleIcon} size={13} />;
  }
}

/** "18s", "4m", "1h 2m" since work began, ticking with the shared second clock. */
function Elapsed(props: { since: number }) {
  const now = useSeconds(true);
  return <span className="tabular-nums">{formatSpan(props.since, now)}</span>;
}

/** The status in a few words and a mark; a working thread counts the time it has been at it. */
export function RowPill(props: { pill: TaskPill }) {
  const { pill } = props;
  return (
    <span
      data-tone={pill.tone}
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-1 text-xs font-medium whitespace-nowrap",
        pillTone[pill.tone],
      )}
    >
      <PillIcon pill={pill} />
      {pill.label}
      {pill.since !== undefined && <Elapsed since={pill.since} />}
    </span>
  );
}

/**
 * The row's first line: the project's badge and name, then on the right a pin and a snooze,
 * and the status pill or, for a thread at rest, how long ago it last moved. The right side
 * gives way to Settle and Snooze on hover and focus.
 */
export function RowHead(props: { card: ThreadCard }) {
  const { card } = props;
  return (
    <span className="flex h-[18px] items-center gap-1.5">
      <ProjectMark badge={card.badge} />
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{card.project}</span>
      <span className="flex shrink-0 items-center gap-1.5 text-subtle-foreground group-focus-within/row:invisible group-hover/row:invisible">
        {card.flags.pinned && <Icon icon={PushPinIcon} size={12} />}
        {card.wake && <Icon icon={MoonIcon} size={12} />}
        {card.pill ? (
          <RowPill pill={card.pill} />
        ) : (
          <span className="text-xs tabular-nums">{card.age}</span>
        )}
      </span>
    </span>
  );
}

/** The title: medium and bright when it needs you or has news, quiet once the work is behind you. */
export function RowTitle(props: { card: ThreadCard; children: ReactNode }) {
  const { card } = props;
  return (
    <span
      className={cn(
        "block truncate text-base tracking-[-0.005em]",
        card.emphasis
          ? "font-medium text-foreground"
          : card.dimmed
            ? "text-muted-foreground"
            : "text-sidebar-foreground",
        "group-data-[status=active]/link:text-foreground",
      )}
    >
      {props.children}
    </span>
  );
}

/** The diff as +added −removed in the only colours a row carries, or the pull request. */
function ChangeMark(props: { card: ThreadCard }) {
  const { branch, diff } = props.card;
  if (branch?.pr !== undefined)
    return (
      <span className="inline-flex items-center gap-0.5 text-muted-foreground">
        <Icon icon={GitPullRequestIcon} size={12} />#{branch.pr}
      </span>
    );
  if (!diff) return null;
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      {diff.added > 0 && <span className="text-diff-add">+{diff.added}</span>}
      {diff.removed > 0 && <span className="text-diff-del">−{diff.removed}</span>}
    </span>
  );
}

/** The provider's mark, with the count of subagents working beside it. */
function ProviderMark(props: { card: ThreadCard }) {
  const { card } = props;
  return (
    <span className="relative inline-flex text-muted-foreground">
      <ProviderIcon provider={card.provider} acpAgentId={card.acpAgentId} size={12} decorative />
      {card.subagents > 0 && (
        <span className="absolute -right-1.5 -bottom-1 min-w-3 rounded-full bg-sidebar px-[2px] text-center text-[8.5px] leading-3 font-semibold text-foreground shadow-[0_0_0_1px_var(--sidebar-border)]">
          {card.subagents}
        </span>
      )}
    </span>
  );
}

/** The row's last line: where the work happens (branch or worktree, another machine), then what changed and who does it. */
export function RowFoot(props: { card: ThreadCard }) {
  const { card } = props;
  const branch = card.branch;
  return (
    <span className="flex h-4 items-center gap-1.5 text-xs text-subtle-foreground">
      <span className="flex min-w-0 flex-1 items-center gap-1">
        {branch?.worktree && <Icon icon={GitBranchIcon} size={12} className="opacity-80" />}
        <span className="truncate">
          {branch?.name}
          {card.machine && <span> · {card.machine}</span>}
        </span>
      </span>
      <ChangeMark card={card} />
      <ProviderMark card={card} />
    </span>
  );
}

/** A settled row's line: badge, title and age. */
export function SettledLine(props: { card: ThreadCard }) {
  return (
    <>
      <ProjectMark badge={props.card.badge} className="opacity-70" />
      {/* Unsettle covers the title's end on hover; fade it rather than cut it. */}
      <span className="min-w-0 flex-1 truncate [--under:2.25rem] group-focus-within/row:fade-under-actions group-hover/row:fade-under-actions">
        {props.card.title}
        <span className="sr-only">. {threadDetails(props.card).join(", ")}</span>
      </span>
      <span
        aria-hidden
        className="text-[11px] group-focus-within/row:invisible group-hover/row:invisible"
      >
        {props.card.age}
      </span>
    </>
  );
}
