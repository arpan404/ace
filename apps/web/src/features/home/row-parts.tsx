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
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";

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

/**
 * The first line's status, as loud as the row's attention (`rowAttention`, with the open
 * thread's `currentAttention`):
 * - what asks the person to act or look: a glyph and a word in the status colour;
 * - live work in a row not open: its small moving glyph and a muted word, no running clock;
 * - the open thread's live work: the coloured word with its elapsed time;
 * - a failure already seen: a quiet word; a thread at rest: only its age.
 */
export function RowStatus(props: { card: ThreadCard; attention: RowAttention }) {
  const { card } = props;
  const { level, word, tone, muted } = props.attention;
  if (word === undefined) return <RowTime card={card} />;
  if (level === "failed-seen")
    return <span className="shrink-0 text-xs text-muted-foreground">{word}</span>;
  // The glyph beside the word: the colour is never the only clue.
  const mark = (
    <StatusGlyph state={threadGlyph({ tone, mark: card.status.mark })} tone={tone} size={12} />
  );
  if (muted)
    return (
      <span
        data-tone={tone}
        className="inline-flex shrink-0 items-center gap-1 text-xs whitespace-nowrap text-muted-foreground"
      >
        {mark}
        <span>{word}</span>
      </span>
    );
  return (
    <StatusLabel tone={tone} label={word} mark={mark} className="gap-1 text-xs font-normal">
      {tone === "working" && <WorkingFor card={card} />}
    </StatusLabel>
  );
}

/** How long the tree has been working, on the shared second clock while the facts are fresh. */
function WorkingFor(props: { card: ThreadCard }) {
  const { since } = props.card.status;
  const fresh = useLiveConnection().fresh;
  const now = useSeconds(fresh && since !== undefined);
  if (!fresh || since === undefined) return null;
  return <span className="tabular-nums">{formatSpan(since, now)}</span>;
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

/**
 * Branch and pull request lead the last line; the provider keeps the trailing slot. A row never
 * names its machine: with more than one device connected, the machine's icon sits beside the
 * provider's, its name in the tooltip and the row's spoken details.
 */
export function RowContext(props: { card: ThreadCard }) {
  const { card } = props;
  const devices = use(ManyDevices);
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
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
          {card.subagents > 0 && <span className="tabular-nums">{card.subagents}</span>}
          {/* A black-and-white mark (OpenAI, OpenCode) takes the row's muted ink beside the
              machine glyph; coloured marks keep their own colours. */}
          <ProviderIcon
            provider={card.provider}
            acpAgentId={card.acpAgentId}
            size={14}
            decorative
            className="text-muted-foreground"
          />
        </span>
      </span>
    </div>
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
  if (level === "needs-you" || level === "failed") return "font-medium text-foreground";
  return attention.muted ? "text-muted-foreground" : "text-foreground";
}
