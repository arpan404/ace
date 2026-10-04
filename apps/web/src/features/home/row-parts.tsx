import { GitBranchIcon, GitPullRequestIcon, MoonIcon } from "@phosphor-icons/react";
import type { ThreadCard, ThreadMarkKind } from "@ace/ui-core";
import type { ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";

/*
 * Pure pieces of a Home row. They render a `ThreadCard` view model and know nothing about the
 * client, the organizer or routing.
 */

/**
 * The only colour on a row: an amber dot for needs you, red for failed, a hollow ring for
 * unresponsive and a grey spinner while it works; waiting and done show nothing. The status word
 * is for assistive tech.
 */
export function StatusMark(props: { mark: ThreadMarkKind; label: string }) {
  return (
    <>
      {props.mark === "working" ? (
        <Spinner />
      ) : props.mark === "none" ? null : (
        <Dot tone={props.mark} />
      )}
      <span className="sr-only">{props.label}</span>
    </>
  );
}

/**
 * What a row says beyond its title, in words: the status, the provider and its subagents, the
 * worktree or branch, the pull request, another machine, a snooze. Assistive tech hears it as
 * part of the row; the row's tooltip shows it to the pointer and the keyboard.
 */
export function threadDetails(card: ThreadCard): string[] {
  const branch = card.branch;
  return [
    card.status.label,
    card.providerLabel,
    branch && `${branch.worktree ? "Worktree" : "Branch"} ${branch.name}`,
    branch?.pr !== undefined && `Pull request #${branch.pr}`,
    card.machine && `Running on ${card.machine}`,
    card.wake && `Snoozed until ${card.wake}`,
  ].filter((part): part is string => typeof part === "string" && part.length > 0);
}

/**
 * A Home row's one line: the title (medium when it needs you, is unread or is open), then on
 * the right a snooze, its worktree and pull request, and the status mark. Those marks are only
 * decoration, giving way to Settle and Snooze on hover and focus; the words for them stay in
 * the row's name (`threadDetails`), which nothing hides.
 */
export function ThreadLine(props: { card: ThreadCard; title: ReactNode }) {
  const { card } = props;
  const branch = card.branch;
  return (
    <>
      <span
        className={cn(
          "min-w-0 flex-1 truncate tracking-[-0.005em] text-sidebar-foreground",
          "group-data-[status=active]/link:font-medium group-data-[status=active]/link:text-foreground",
          card.emphasis && "font-medium text-foreground",
        )}
      >
        {props.title}
        {card.announceUnread && <span className="sr-only">, unread</span>}
        <span className="sr-only">. {threadDetails(card).join(", ")}</span>
      </span>
      <span
        aria-hidden
        className="flex shrink-0 items-center gap-1 text-subtle-foreground group-focus-within/row:invisible group-hover/row:invisible"
      >
        {card.wake && <Icon icon={MoonIcon} size={13} />}
        {branch?.worktree && <Icon icon={GitBranchIcon} size={13} />}
        {branch?.pr !== undefined && <Icon icon={GitPullRequestIcon} size={13} />}
        {card.status.mark === "working" ? (
          <Spinner />
        ) : card.status.mark === "none" ? null : (
          <Dot tone={card.status.mark} />
        )}
      </span>
    </>
  );
}

/** A settled row's line: title, status mark and age. */
export function SettledLine(props: { card: ThreadCard }) {
  return (
    <>
      {/* Unsettle covers the title's end on hover; fade it rather than cut it. */}
      <span className="min-w-0 flex-1 truncate [--under:2.25rem] group-focus-within/row:fade-under-actions group-hover/row:fade-under-actions">
        {props.card.title}
      </span>
      <StatusMark mark={props.card.status.mark} label={props.card.status.label} />
      <span className="text-[11px] group-focus-within/row:invisible group-hover/row:invisible">
        {props.card.age}
      </span>
    </>
  );
}
