import { createContext, use } from "react";
import { PullRequestGlyph, pullRequestTone } from "@/components/pull-request-state.tsx";
import { rowStatusLook, type RowAttention, type ThreadCard } from "@ace/ui-core";
import { StatusIcon } from "@/components/status-icons.tsx";
import { formatSpan } from "@ace/ui-core";
import { useSeconds } from "@/lib/time.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { useMachines } from "@/lib/machines.ts";
import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { MiddleTruncate } from "@/components/ui/middle-truncate.tsx";
import { cn } from "@/lib/cn.ts";
import { useThreadBrowsing } from "@/lib/browsing.ts";
import { useThreadComputerUse } from "@/lib/computer-using.ts";
import {
  ClockIcon,
  CursorClickIcon,
  GlobeSimpleIcon,
  TreeStructureIcon,
} from "@phosphor-icons/react";
import type { LinkClick } from "@/lib/web-links.ts";
import { useOpenThreadPullRequest } from "./open-pull-request.ts";

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
    card.wake && `Snoozed ${card.wake}`,
  ].filter((part): part is string => typeof part === "string" && part.length > 0);
}

export { ProjectMark } from "@/components/project-mark.tsx";

/** A quiet globe in the working colour while an agent works in the thread's browser. */
export function BrowsingMark(props: { threadId: string }) {
  if (!useThreadBrowsing(props.threadId)) return null;
  return (
    <Tip label="An agent is browsing">
      <span
        role="img"
        aria-label="An agent is browsing"
        data-tone="working"
        className="inline-flex shrink-0 text-status-working"
      >
        <GlobeSimpleIcon aria-hidden size={12} />
      </span>
    </Tip>
  );
}

/** "Calculator", "Calculator and Notes", "Calculator, Notes and 2 more". */
function appList(apps: readonly string[]): string {
  if (apps.length <= 2) return apps.join(" and ");
  return `${apps.slice(0, 2).join(", ")} and ${apps.length - 2} more`;
}

/** A quiet cursor in the working colour while an agent uses Mac apps for the thread. */
export function ComputerUseMark(props: { threadId: string }) {
  const apps = useThreadComputerUse(props.threadId);
  if (!apps.length) return null;
  const label = `An agent is using ${appList(apps)}`;
  return (
    <Tip label={label}>
      <span
        role="img"
        aria-label={label}
        data-tone="working"
        className="inline-flex shrink-0 text-status-working"
      >
        <CursorClickIcon aria-hidden size={12} />
      </span>
    </Tip>
  );
}

/** State is also spoken, so the PR's colour is never the only clue. */
export function PullRequest(props: { card: ThreadCard }) {
  const { pr, prState } = props.card;
  const openPullRequest = useOpenThreadPullRequest(props.card.id);
  if (pr === undefined) return null;
  const linked = props.card.prs?.[0];
  const url = linked?.url;
  const more = (props.card.prs?.length ?? 0) - 1;
  const label = `${prState ?? "Linked"} pull request #${pr}${more > 0 ? `, ${more} more linked` : ""}`;
  const content = (
    <>
      <PullRequestGlyph state={prState} size={12} />#{pr}
      {more > 0 && <span>+{more}</span>}
    </>
  );
  const tone = cn("inline-flex items-center gap-0.5", prState && pullRequestTone(prState));
  if (!url)
    return (
      <span role="img" aria-label={label} className={tone}>
        {content}
      </span>
    );
  // The row is itself a link, so the badge opens the pull request without nesting an anchor;
  // the row stays the one focus stop. It opens ace's page for the PR (⌘/Ctrl-click: GitHub).
  const open = (event: { preventDefault(): void; stopPropagation(): void }, click?: LinkClick) => {
    event.preventDefault();
    event.stopPropagation();
    openPullRequest({ number: linked?.number ?? pr, url, repo: linked?.repo }, click);
  };
  return (
    <span
      role="button"
      tabIndex={-1}
      aria-label={`Open ${label}`}
      onClick={(event) => open(event, event)}
      onAuxClick={(event) => {
        if (event.button === 1) open(event, event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") open(event);
      }}
      className={cn(tone, "cursor-pointer underline-offset-2 hover:underline")}
    >
      {content}
    </span>
  );
}

/**
 * The first line's status: one solid icon and one short word or time (`rowStatusLook`), 14px
 * with a 5px gap, vertically centred. Nothing animates. Needs-you and failed words take the
 * state's colour; elapsed and relative times stay in muted ink. The row's accessible name keeps
 * the full wording (`threadDetails`), so the short visual word never stands alone for
 * assistive tech.
 */
export function RowStatus(props: { card: ThreadCard; attention: RowAttention }) {
  const { card } = props;
  const { level } = props.attention;
  // A snoozed row says what it waits for where its status sits, unless it needs the person.
  if (card.wake && level !== "needs-you" && level !== "failed") return <RowWake wake={card.wake} />;
  const look = rowStatusLook(props.attention, card);
  if (look.mode === "elapsed") {
    return (
      <span
        role="img"
        aria-label={look.full}
        data-tone={look.tone}
        className="inline-flex shrink-0 items-center gap-[5px] text-meta whitespace-nowrap"
      >
        <span className="inline-flex text-(--tone)">
          <StatusIcon kind={look.icon === "none" ? "waiting" : look.icon} size={14} />
        </span>
        <ActiveElapsed card={card} />
      </span>
    );
  }
  if (look.mode === "age") {
    return (
      <span
        role="img"
        aria-label={look.full}
        data-tone={look.tone}
        className="inline-flex shrink-0 items-center gap-[5px] text-meta whitespace-nowrap"
      >
        {look.icon !== "none" && (
          <span className="inline-flex text-(--tone)">
            <StatusIcon kind={look.icon} size={14} />
          </span>
        )}
        <RowTime card={card} />
      </span>
    );
  }
  // A quiet word (a seen failure, an unconfirmed copy): no icon, no colour, no time.
  if (look.icon === "none") {
    return (
      <span role="img" aria-label={look.full} className="shrink-0 text-meta text-muted-foreground">
        {look.word}
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={look.full}
      data-tone={look.tone}
      className="inline-flex shrink-0 items-center gap-[5px] text-meta font-medium whitespace-nowrap text-(--tone-text)"
    >
      <span className="inline-flex text-(--tone)">
        <StatusIcon kind={look.icon} size={14} />
      </span>
      <span>{look.word}</span>
    </span>
  );
}

/**
 * How long an active row has been at it, open or not: working reads its live elapsed time on
 * the shared second clock while the facts are fresh, everything else its age. Falls back to
 * the age when disconnected, so the time never disappears.
 */
function ActiveElapsed(props: { card: ThreadCard }) {
  const { since } = props.card.status;
  const fresh = useLiveConnection().fresh;
  const now = useSeconds(fresh && since !== undefined);
  if (fresh && since !== undefined) {
    return <span className="text-muted-foreground tabular-nums">{formatSpan(since, now)}</span>;
  }
  return <span className="text-muted-foreground tabular-nums">{props.card.age}</span>;
}

/** A snoozed row says what it waits for ("until it needs you") where others say their status. */
function RowWake(props: { wake: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-meta whitespace-nowrap text-muted-foreground">
      <ClockIcon aria-hidden size={12} />
      {props.wake}
    </span>
  );
}

function RowTime(props: { card: ThreadCard }) {
  const { card } = props;
  const fresh = useLiveConnection().fresh;
  const ongoing = !card.flags.settled && card.status.tone !== "done" && card.status.tone !== "idle";
  const now = useSeconds(fresh && ongoing && card.status.since !== undefined);
  return (
    <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
      {ongoing && card.status.since !== undefined && fresh
        ? formatSpan(card.status.since, now)
        : card.age}
    </span>
  );
}

/**
 * An Active row's last line: the branch and pull request lead; the provider keeps the trailing
 * slot. With more than one device connected, the machine's icon sits beside the provider's, its
 * name in the tooltip and the row's spoken details.
 */
export function RowContext(props: { card: ThreadCard }) {
  const { card } = props;
  const devices = use(ManyDevices);
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-meta leading-4 text-subtle-foreground">
      {card.branch && <MiddleTruncate text={card.branch.name} className="flex-1 font-mono" />}
      {card.pr !== undefined && (
        <span className="shrink-0">
          <PullRequest card={card} />
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {devices && (
          <Tip label={card.machine ?? "This machine"}>
            <span className="inline-flex">
              <MachineMark icon={card.machineIcon} />
            </span>
          </Tip>
        )}
        <span role="img" aria-label={card.providerLabel} className="flex items-center gap-1">
          {card.subagents > 0 && (
            <span className="inline-flex items-center gap-0.5 tabular-nums">
              <TreeStructureIcon aria-hidden size={12} />
              {card.subagents}
            </span>
          )}
          {/* A black-and-white mark (OpenAI, OpenCode) takes the row's muted ink; coloured marks
              keep their own colours. */}
          <ProviderAccountIcon
            provider={card.provider}
            acpAgentId={card.acpAgentId}
            instance={card.account}
            size={14}
            decorative
            className="text-subtle-foreground"
          />
        </span>
      </span>
    </div>
  );
}

/**
 * More than one of the person's devices is connected: Active rows show their machine's icon. The
 * list reads the machines once and hands the answer to every row.
 */
export const ManyDevices = createContext(false);

/** More than one of the person's devices is connected: rows show their machine's icon. */
export function useManyDevices(): boolean {
  return useMachines().filter((machine) => machine.status === "online").length > 1;
}

/**
 * The title's ink from the row's attention level: what needs the person or failed unseen is
 * full contrast and medium weight, live work and unread results full contrast, and everything
 * at rest drops to the muted ink. The title itself always shows.
 */
export function titleTone(attention: RowAttention): string {
  const { level } = attention;
  // Titles always carry weight 500; muted attention changes the ink, never the weight.
  if (level === "needs-you" || level === "failed") return "font-medium text-foreground";
  return attention.muted ? "font-medium text-muted-foreground" : "font-medium text-foreground";
}
