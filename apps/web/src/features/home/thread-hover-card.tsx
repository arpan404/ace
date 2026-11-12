import type { ReactNode } from "react";
import type { ThreadListEntry } from "@ace/protocol";
import { currentAttention, modelLabel, providerDisplayName, type ThreadCard } from "@ace/ui-core";
import { GitBranchIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { HoverCardContent } from "@/components/ui/hover-card-content.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { useAccountViews } from "@/lib/account-views.ts";
import { BrowsingMark, ComputerUseMark, ProjectMark, PullRequest } from "./row-parts.tsx";
import { HoverStatus } from "./hover-status.tsx";
import { LinkedPullRequestLink, ThreadHoverPrs } from "./thread-hover-prs.tsx";

/** One compact line of the card: a glyph and its fact. */
function Fact(props: { children: ReactNode }) {
  return <div className="flex h-5 min-w-0 items-center gap-1.5">{props.children}</div>;
}

/** Running subagents: a tree glyph and how many. */
export function SubagentCount(props: { count: number }) {
  const label = `${props.count} ${props.count === 1 ? "subagent" : "subagents"} running`;
  return (
    <span
      role="img"
      aria-label={label}
      className="ml-auto inline-flex shrink-0 items-center gap-1 tabular-nums"
    >
      <TreeStructureIcon aria-hidden size={14} />
      {props.count}
    </span>
  );
}

/** Metadata already in the row and shared account cache; no history or per-thread fetch. */
export function ThreadHoverContent(props: {
  card: ThreadCard;
  entry: ThreadListEntry;
  instance: string | undefined;
  /**
   * Where it opens: beside the row (a sidebar row's, the default), or under it (`below`, a
   * transcript row's), flipping above when there's no room under it.
   */
  placement?: "beside" | "below" | undefined;
}) {
  const below = props.placement === "below";
  const { card, entry } = props;
  const accounts = useAccountViews();
  const account = props.instance
    ? accounts.data?.find((candidate) => candidate.id === props.instance)
    : undefined;
  const linkedPr = card.prs?.[0];
  const queued =
    entry.switch?.state === "queued" && entry.switch.selection.instanceId === account?.id;
  // A queued switch names its account and model together, never its account with the old model.
  const model =
    (queued ? entry.switch?.selection.model : undefined) ??
    entry.live?.model ??
    entry.execution?.model;
  return (
    <HoverCardContent
      // Beside the row, level with its top, so it never covers the rows below; it flips to the
      // left only when the window has no room on the right. Under a transcript row instead,
      // aligned with its start, flipping above it when the window has no room below.
      side={below ? "bottom" : "right"}
      sideOffset={below ? 4 : 8}
      align="start"
      collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
      aria-label={`Details for ${card.title}`}
      className="w-80 max-w-[calc(100vw-24px)] max-h-[min(var(--available-height),400px,calc(100dvh-24px))] overflow-y-auto px-3 py-2 break-words"
    >
      <p className="truncate text-ui leading-5 font-medium text-foreground" title={card.title}>
        {card.title}
      </p>
      {/* What the thread waits on, in words, by the row's own attention so the two never
          disagree, then what an agent is driving (a browser, Mac apps). */}
      <div data-hover-status className="mt-0.5 flex items-start gap-1.5">
        <HoverStatus card={card} entry={entry} attention={currentAttention(card.attention, true)} />
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pt-1">
          <BrowsingMark threadId={entry.id} />
          <ComputerUseMark threadId={entry.id} />
        </span>
      </div>
      <div className="mt-1 text-ui text-muted-foreground">
        <Fact>
          <ProjectMark id={entry.workspaceId} badge={card.badge} />
          <span className="min-w-0 truncate">{card.project}</span>
        </Fact>
        <Fact>
          <MachineMark icon={card.machineIcon} />
          <span className="min-w-0 truncate">{card.machine ?? "This machine"}</span>
        </Fact>
        {card.branch && (
          <Fact>
            <GitBranchIcon aria-hidden size={14} className="shrink-0" />
            {linkedPr ? (
              <LinkedPullRequestLink
                threadId={card.id}
                pr={linkedPr}
                label={`Open pull request for ${card.branch.name}`}
              >
                {card.branch.name}
              </LinkedPullRequestLink>
            ) : (
              <span className="min-w-0 truncate">{card.branch.name}</span>
            )}
          </Fact>
        )}
        <Fact>
          {/* A black-and-white mark takes the card's muted ink, as in the row. */}
          <ProviderIcon
            provider={card.provider}
            acpAgentId={card.acpAgentId}
            size={14}
            decorative
            className="text-muted-foreground"
          />
          {/* The account and the model; the icon already names the provider. */}
          <span className="min-w-0 truncate">
            {account ? `${account.label}${queued ? " (queued)" : ""}` : ""}
            {account && model ? " · " : ""}
            {model ? (
              <span data-model={model} aria-label={`Model: ${modelLabel(model)}`}>
                {modelLabel(model)}
              </span>
            ) : account ? null : (
              providerDisplayName(card.provider, card.acpAgentId)
            )}
          </span>
          {card.subagents > 0 && <SubagentCount count={card.subagents} />}
        </Fact>
      </div>
      {(card.pr !== undefined || card.diff) && (
        <div className="mt-1 border-t border-border pt-1 text-ui text-muted-foreground">
          {card.prs?.length ? (
            <ThreadHoverPrs threadId={card.id} prs={card.prs} />
          ) : card.pr !== undefined ? (
            <Fact>
              <PullRequest card={card} />
            </Fact>
          ) : null}
          {card.diff && (
            <Fact>
              <span
                role="img"
                aria-label={`${card.diff.added} lines added, ${card.diff.removed} lines removed`}
                className="inline-flex gap-1.5 tabular-nums"
              >
                <span className="text-status-done">+{card.diff.added}</span>
                <span className="text-status-failed">−{card.diff.removed}</span>
              </span>
            </Fact>
          )}
        </div>
      )}
    </HoverCardContent>
  );
}
