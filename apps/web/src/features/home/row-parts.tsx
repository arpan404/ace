import { GitBranchIcon, GitPullRequestIcon, MoonIcon } from "@phosphor-icons/react";
import type { ThreadCard, ThreadMarkKind } from "@ace/ui-core";
import type { ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
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

function Glyph(props: { icon: typeof MoonIcon; label: string }) {
  return (
    <Tip label={props.label}>
      <span className="inline-flex text-subtle-foreground">
        <Icon icon={props.icon} size={13} label={props.label} />
      </span>
    </Tip>
  );
}

/**
 * A Home row's one line: the title (medium when it needs you, is unread or is open), then on
 * the right a snooze, its worktree and pull request, and the status mark. The provider and
 * another machine are said in words to assistive tech; the thread's header shows them. The
 * right side gives way to Settle and Snooze on hover.
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
        {card.machine && <span className="sr-only">, running on {card.machine}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1 group-focus-within/row:invisible group-hover/row:invisible">
        {card.wake && <Glyph icon={MoonIcon} label={`Snoozed until ${card.wake}`} />}
        {branch?.worktree && <Glyph icon={GitBranchIcon} label={`Worktree ${branch.name}`} />}
        {branch?.pr !== undefined && (
          <Glyph icon={GitPullRequestIcon} label={`Pull request #${branch.pr}`} />
        )}
        <StatusMark mark={card.status.mark} label={card.status.label} />
        <span className="sr-only">{card.providerLabel}</span>
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
