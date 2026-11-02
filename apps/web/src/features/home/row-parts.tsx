import { PullRequestGlyph, pullRequestTone } from "@/components/pull-request-state.tsx";
import {
  rowStatusLook,
  type RowAttention,
  type RowStatusLook,
  type ThreadCard,
} from "@ace/ui-core";
import { StatusIcon } from "@/components/status-icons.tsx";
import { AgentCursorIcon, BrowserUseIcon } from "@/components/ace-icons.tsx";
import { formatElapsed } from "@ace/ui-core";
import { useSeconds } from "@/lib/time.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { useMachines } from "@/lib/machines.ts";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { MiddleTruncate } from "@/components/ui/middle-truncate.tsx";
import { cn } from "@/lib/cn.ts";
import { useThreadBrowsing } from "@/lib/browsing.ts";
import { useThreadComputerUse } from "@/lib/computer-using.ts";
import { ClockIcon, TreeStructureIcon } from "@phosphor-icons/react";
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

/** The globe with the agent's pointer, in the working colour, while an agent works in the thread's browser. */
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
        <BrowserUseIcon aria-hidden size={14} />
      </span>
    </Tip>
  );
}

/** "Calculator", "Calculator and Notes", "Calculator, Notes and 2 more". */
function appList(apps: readonly string[]): string {
  if (apps.length <= 2) return apps.join(" and ");
  return `${apps.slice(0, 2).join(", ")} and ${apps.length - 2} more`;
}

/** The agent cursor (the Pebble, as drawn over apps and pages) while an agent uses Mac apps for the thread. */
export function ComputerUseMark(props: { threadId: string }) {
  const apps = useThreadComputerUse(props.threadId);
  if (!apps.length) return null;
  const label = `An agent is using ${appList(apps)}`;
  return (
    <Tip label={label}>
      <span role="img" aria-label={label} data-tone="working" className="inline-flex shrink-0">
        <AgentCursorIcon aria-hidden size={13} />
      </span>
    </Tip>
  );
}

/**
 * State is also spoken, so the PR's colour is never the only clue. `ink="muted"` (rows) draws it
 * in the surrounding muted ink; the hover card keeps the state's colour.
 */
export function PullRequest(props: { card: ThreadCard; ink?: "state" | "muted" | undefined }) {
  const { pr, prState } = props.card;
  const openPullRequest = useOpenThreadPullRequest(props.card.id);
  if (pr === undefined) return null;
  const linked = props.card.prs?.[0];
  const url = linked?.url;
  const more = (props.card.prs?.length ?? 0) - 1;
  const label = `${prState ?? "Linked"} pull request #${pr}${more > 0 ? `, ${more} more linked` : ""}`;
  const content = (
    <>
      <PullRequestGlyph state={props.ink === "muted" ? undefined : prState} size={12} />#{pr}
      {more > 0 && <span>+{more}</span>}
    </>
  );
  const tone = cn(
    "inline-flex items-center gap-0.5",
    props.ink !== "muted" && prState && pullRequestTone(prState),
  );
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

/** A row's status icon in its state's colour, silent: the row and its tooltip say the state. */
export function LookIcon(props: { look: RowStatusLook }) {
  const { look } = props;
  if (look.icon === "none") return null;
  return <StatusIcon kind={look.icon} tone={look.tone} count={look.count} size={16} />;
}

/**
 * The first line's status, without words (`rowStatusLook`): what needs the person, a fresh
 * failure and unseen finished work are their 16px icon alone; working, waiting and background
 * work its icon and elapsed time; a seen failure its quiet icon and age; everything else its age
 * in muted ink. Each icon is in its state's colour (`StatusIcon`). The
 * meaning ("Needs approval") is the tooltip and the element's name, and the row's accessible
 * name leads with it too, so nothing rests on the icon's shape or colour. Nothing animates.
 */
export function RowStatus(props: { card: ThreadCard; attention: RowAttention }) {
  const { card } = props;
  const { level } = props.attention;
  // A snoozed row says what it waits for where its status sits, unless it needs the person.
  if (card.wake && level !== "needs-you" && level !== "failed") return <RowWake wake={card.wake} />;
  const look = rowStatusLook(props.attention, card);
  return (
    <Tip label={look.meaning}>
      <span
        role="img"
        aria-label={look.meaning}
        data-tone={look.tone}
        data-status-mode={look.mode}
        className="inline-flex shrink-0 items-center gap-[5px] text-meta whitespace-nowrap text-muted-foreground"
      >
        <LookIcon look={look} />
        {look.mode === "elapsed" && <ActiveElapsed card={card} />}
        {look.mode === "age" && <RowTime card={card} />}
        {look.mode === "word" && <span>{look.word}</span>}
      </span>
    </Tip>
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
    return <span className="text-muted-foreground tabular-nums">{formatElapsed(now - since)}</span>;
  }
  return <span className="text-muted-foreground tabular-nums">{props.card.age}</span>;
}

/** A snoozed row says what it waits for ("until it needs you") where others say their status. */
export function RowWake(props: { wake: string }) {
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
        ? formatElapsed(now - card.status.since)
        : card.age}
    </span>
  );
}

/**
 * An Active row's last line, all in muted ink: the branch and pull request lead; the provider
 * keeps the trailing slot as a grey mark (the hover card names the account). A thread on another
 * machine shows that machine's icon beside it, its name in the tooltip and the row's spoken
 * details; one on this machine shows none.
 */
export function RowContext(props: {
  card: ThreadCard;
  /** The thread runs on another machine (not this window's own). */
  remote: boolean;
}) {
  const { card } = props;
  return (
    <div
      data-row-context=""
      className="flex h-4 min-w-0 items-center justify-end gap-1.5 text-meta leading-4 text-subtle-foreground"
    >
      {card.branch && (
        <MiddleTruncate text={card.branch.name} className="min-w-0 flex-1 font-mono" />
      )}
      {card.pr !== undefined && (
        <span className="shrink-0">
          <PullRequest card={card} ink="muted" />
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {/* What an agent is using for the thread, beside who runs it; the row's actions never cover them. */}
        <BrowsingMark threadId={card.id} />
        <ComputerUseMark threadId={card.id} />
        {props.remote && (
          <Tip label={card.machine ?? "Another machine"}>
            <span data-machine-mark="" className="inline-flex">
              <MachineMark icon={card.machineIcon} primary={false} />
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
          <ProviderIcon
            provider={card.provider}
            acpAgentId={card.acpAgentId}
            size={14}
            decorative
            className="text-foreground opacity-80"
          />
        </span>
      </span>
    </div>
  );
}

/** More than one of the person's devices is connected. */
export function useManyDevices(): boolean {
  return useMachines().filter((machine) => machine.status === "online").length > 1;
}

/**
 * Whether a row's title is semibold: only when the thread needs the person (an approval, a
 * question, a model to pick). Every other title, open or not, is regular weight.
 */
export function boldTitle(attention: RowAttention): boolean {
  return attention.level === "needs-you";
}

/**
 * The title's ink and weight from the row's attention level: semibold for what needs the person
 * (`boldTitle`), full contrast for live work, and the muted ink for everything at rest. The
 * title itself always shows.
 */
export function titleTone(attention: RowAttention): string {
  if (boldTitle(attention)) return "font-semibold text-foreground";
  return attention.muted ? "text-muted-foreground" : "text-foreground";
}
