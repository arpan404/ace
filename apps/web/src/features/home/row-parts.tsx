import { createContext, use } from "react";
import { PullRequestGlyph, pullRequestTone } from "@/components/pull-request-state.tsx";
import { type RowAttention, type ThreadCard } from "@ace/ui-core";
import { StatusGlyph } from "@/components/status-glyph.tsx";
import { threadGlyph } from "@/components/status-glyph-state.ts";
import { formatSpan } from "@ace/ui-core";
import { useSeconds } from "@/lib/time.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { StatusLabel } from "@/components/status-label.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { useMachines } from "@/lib/machines.ts";
import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { useThreadBrowsing } from "@/lib/browsing.ts";
import { useThreadComputerUse } from "@/lib/computer-using.ts";
import {
  ClockIcon,
  CursorClickIcon,
  GlobeSimpleIcon,
  TreeStructureIcon,
} from "@phosphor-icons/react";
import { openExternal } from "@/boot/open-external.ts";

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
  if (pr === undefined) return null;
  const url = props.card.prs?.[0]?.url;
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
  // the row stays the one focus stop.
  const open = (event: { preventDefault(): void; stopPropagation(): void }) => {
    event.preventDefault();
    event.stopPropagation();
    void openExternal(url).catch(() => {});
  };
  return (
    <span
      role="button"
      tabIndex={-1}
      aria-label={`Open ${label}`}
      onClick={open}
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
 * The first line's status, as loud as the row's attention (`rowAttention`, with the open
 * thread's `currentAttention`):
 * - what asks the person to act or look: a glyph and a word in the status colour;
 * - live work, waiting or background, open or not: its glyph (none for waiting), word and
 *   elapsed time, muted unless open;
 * - a failure already seen: a quiet word; a thread at rest: only its age.
 */
export function RowStatus(props: { card: ThreadCard; attention: RowAttention }) {
  const { card } = props;
  const { level, word, tone, muted } = props.attention;
  if (word === undefined) return card.wake ? <RowWake wake={card.wake} /> : <RowTime card={card} />;
  // An unconfirmed copy says only that it is syncing: no glyph, no colour, no time.
  if (level === "failed-seen" || level === "syncing")
    return <span className="shrink-0 text-meta text-muted-foreground">{word}</span>;
  // The glyph beside the word: the colour is never the only clue. Waiting is only words.
  const mark =
    tone === "waiting" ? null : (
      <StatusGlyph state={threadGlyph({ tone, mark: card.status.mark })} tone={tone} size={12} />
    );
  // Active rows always keep their time beside the word, open or not: the open row is not the
  // only one that says how long it has been at it. "Limited HH:MM" already names its time.
  const elapsed =
    level === "active" && !word.startsWith("Limited") ? <ActiveElapsed card={card} /> : null;
  // Waiting never takes the status colour, even on the open row.
  if (muted || tone === "waiting")
    return (
      <span
        data-tone={tone}
        className="inline-flex shrink-0 items-center gap-1 text-meta whitespace-nowrap text-muted-foreground"
      >
        {mark}
        <span>{word}</span>
        {elapsed}
      </span>
    );
  return (
    <StatusLabel tone={tone} label={word} mark={mark} className="gap-1 text-meta font-medium">
      {elapsed}
    </StatusLabel>
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
    return <span className="tabular-nums">{formatSpan(since, now)}</span>;
  }
  return <span className="tabular-nums">{props.card.age}</span>;
}

/** Only visible, fresh working rows subscribe to the shared second clock. */
/** A snoozed row says when it wakes where others say their age. */
function RowWake(props: { wake: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-meta whitespace-nowrap text-muted-foreground">
      <ClockIcon aria-hidden size={12} />
      {props.wake}
    </span>
  );
}

export function RowTime(props: { card: ThreadCard }) {
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
 * Branch and pull request lead the last line; the provider keeps the trailing slot. A row never
 * names its machine: with more than one device connected, the machine's icon sits beside the
 * provider's, its name in the tooltip and the row's spoken details.
 */
export function RowContext(props: { card: ThreadCard }) {
  const { card } = props;
  const devices = use(ManyDevices);
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-meta leading-4 text-subtle-foreground">
      {card.run && <RunMark run={card.run} />}
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
          {/* A black-and-white mark (OpenAI, OpenCode) takes the row's muted ink beside the
              machine glyph; coloured marks keep their own colours. */}
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
 * Where a settled thread's Offshift run stopped: its phase word, after a paused ring in the
 * waiting colour when a blocker holds it. Only a settled tree has one (`ThreadCard.run`).
 */
function RunMark(props: { run: NonNullable<ThreadCard["run"]> }) {
  const { run } = props;
  return (
    <Tip label={run.label}>
      <span
        role="img"
        aria-label={run.label}
        data-run={run.blocked ? "blocked" : "open"}
        className="inline-flex shrink-0 items-center gap-1 text-muted-foreground"
      >
        {run.blocked && <StatusGlyph state="paused" tone="waiting" size={12} />}
        {run.phase}
      </span>
    </Tip>
  );
}

/**
 * More than one of the person's devices is connected: rows show their machine's icon. The list
 * reads the machines once and hands the answer to every row.
 */
export const ManyDevices = createContext(false);

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
