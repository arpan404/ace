import { PullRequestGlyph, pullRequestTone } from "@/components/pull-request-state.tsx";
import { type ThreadCard } from "@ace/ui-core";
import { formatSpan } from "@ace/ui-core";
import { useSeconds } from "@/lib/time.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { StatusLabel } from "@/components/status-label.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { LiveWorkMark } from "@/components/live-work-mark.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";

/*
 * Shared row pieces render the card facts. RowStatus reads the shared clock for elapsed time;
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

/**
 * The status as one small mark in its tone: a spinner while working, a dot when it needs you or
 * failed, a hollow ring while it waits on something other than the person. Nothing at rest.
 */
export function StatusMark(props: { card: ThreadCard; muted?: boolean }) {
  const { card } = props;
  const quiet = props.muted ? "text-subtle-foreground" : "";
  switch (card.status.mark) {
    case "working":
      return (
        <span className={props.muted ? undefined : "fx-work-pulse"}>
          <LiveWorkMark className={quiet} />
        </span>
      );
    case "needs-you":
    case "failed":
    case "unresponsive":
    case "limited":
      return <Dot tone={card.status.mark} className={props.muted ? "opacity-50" : ""} />;
    case "none":
      return card.status.tone === "waiting" ? (
        <Dot tone="limited" className={props.muted ? "opacity-50" : ""} />
      ) : null;
  }
}

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

/** Only visible working rows subscribe to the shared second clock. Offline facts stop ticking. */
export function RowStatus(props: { card: ThreadCard }) {
  const { card } = props;
  const muted = quietCard(card);
  const fresh = useLiveConnection().fresh;
  const now = useSeconds(fresh && card.status.since !== undefined);
  if (card.flags.settled || card.status.tone === "done" || card.status.tone === "idle")
    return (
      <span
        className={cn(
          "shrink-0 text-xs tabular-nums",
          muted ? "text-subtle-foreground" : "text-muted-foreground",
        )}
      >
        {card.age}
      </span>
    );
  return (
    <StatusLabel
      tone={card.status.tone}
      label={card.status.compact}
      mark={<StatusMark card={card} muted={muted} />}
      className={cn("gap-1 text-xs", muted && "text-subtle-foreground")}
    >
      {card.status.since !== undefined && fresh && (
        <span className="tabular-nums">{formatSpan(card.status.since, now)}</span>
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

/** Unread results and requests take priority over the canonical dimmed flag. */
export function quietCard(card: ThreadCard): boolean {
  return card.dimmed && !card.emphasis;
}

/** Selection stays readable; ordinary read work uses the quiet ink. */
export function titleTone(card: ThreadCard, selected: boolean): string {
  if (selected) return card.flags.unread ? "font-semibold text-foreground" : "text-foreground";
  if (card.flags.unread) return "font-semibold text-foreground";
  if (card.emphasis) return "text-foreground";
  return quietCard(card) ? "text-subtle-foreground" : "text-sidebar-foreground";
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
        variant="color"
        className={cn(
          "text-muted-foreground",
          quietCard(card) ? "[&>svg]:opacity-65" : "[&>svg]:opacity-75",
        )}
        tooltip={false}
        accountLabel
        decorative
      />
    </span>
  );
}

/** Remote host context stays quiet; the whole row owns its rich hover card. */
export function RowIdentity(props: {
  card: ThreadCard;
  instance?: string | undefined;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5", props.className)}>
      <ProviderMark card={props.card} instance={props.instance} />
    </span>
  );
}

/** Match the sibling cluster's intrinsic width without subscribing or rendering its icons twice. */
export function RowIdentitySpace(props: { card: ThreadCard }) {
  return (
    <span aria-hidden className="invisible inline-flex shrink-0 items-center gap-1.5">
      <span className="inline-flex items-center gap-0.5">
        {props.card.subagents > 0 && (
          <span className="text-2xs tabular-nums">⑂ {props.card.subagents}</span>
        )}
        <span className="size-4" />
      </span>
    </span>
  );
}

/** Task context stays visible while the project-line status gives way to the hover action. */
export function RowDetail(props: {
  card: ThreadCard;
  machinePrimary: boolean;
  model: string | undefined;
}) {
  const { card } = props;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-subtle-foreground">
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate">
          {card.branch?.name ?? props.model}
          {!props.machinePrimary && card.machine && (
            <span className="hidden group-focus-within/row:inline-flex group-hover/row:inline-flex">
              {` · ${card.machine}`}
            </span>
          )}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <PullRequest card={card} />
      </span>
      <RowIdentitySpace card={card} />
    </span>
  );
}
