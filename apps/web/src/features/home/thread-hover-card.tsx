import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import type { ThreadListEntry } from "@ace/protocol";
import { currentAttention, modelLabel, providerDisplayName, type ThreadCard } from "@ace/ui-core";
import { GitBranchIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { HoverCardContent } from "@/components/ui/hover-card.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { useAccountViews } from "@/lib/account-views.ts";
import { ProjectMark, PullRequest, RowStatus } from "./row-parts.tsx";
import { ExternalLink, ThreadHoverPrs } from "./thread-hover-prs.tsx";
import { onScrollMove, scrolledRecently } from "./scroll-rest.ts";

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
}) {
  const { card, entry } = props;
  const accounts = useAccountViews();
  const account = props.instance
    ? accounts.data?.find((candidate) => candidate.id === props.instance)
    : undefined;
  const model = entry.live?.model ?? entry.execution?.model;
  const prUrl = card.prs?.[0]?.url;
  const queued =
    entry.switch?.state === "queued" && entry.switch.selection.instanceId === account?.id;
  return (
    <HoverCardContent
      // Beside the row, level with its top, so it never covers the rows below; it flips to the
      // left only when the window has no room on the right.
      side="right"
      sideOffset={8}
      align="start"
      collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
      aria-label={`Details for ${card.title}`}
      className="w-80 max-w-[calc(100vw-24px)] max-h-[min(var(--available-height),400px,calc(100dvh-24px))] overflow-y-auto px-3 py-2 break-words"
    >
      <p className="truncate text-ui leading-5 font-medium text-foreground" title={card.title}>
        {card.title}
      </p>
      {/* The row's own status, so the card and the row can never word it differently; the
          card is what the person is looking at, so it reads at full contrast. */}
      <div data-hover-status className="mt-0.5 flex">
        <RowStatus card={card} attention={currentAttention(card.attention, true)} />
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
            {prUrl ? (
              <ExternalLink href={prUrl} label={`Open pull request for ${card.branch.name}`}>
                {card.branch.name}
              </ExternalLink>
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
            <ThreadHoverPrs prs={card.prs} />
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

// Only an open preview retains a callback. Closing or unmounting releases it; ordinary row
// renders never subscribe to a global event or fan updates out to the rest of the sidebar.
const active = new WeakMap<Document, { id: string; close(): void }>();
export function useThreadHover() {
  const id = useId();
  const [open, setOpen] = useState(false);
  const change = useCallback(
    (next: boolean) => {
      // Rows sliding under a still pointer while the list scrolls never pop their cards.
      if (next && scrolledRecently(document)) return;
      const previous = active.get(document);
      if (next) {
        if (previous?.id !== id) previous?.close();
        active.set(document, { id, close: () => setOpen(false) });
      } else if (previous?.id === id) active.delete(document);
      setOpen(next);
    },
    [id],
  );
  useEffect(
    () => () => {
      if (active.get(document)?.id === id) active.delete(document);
    },
    [id],
  );
  // An open card closes as soon as the page scrolls; a closed one listens for nothing.
  useEffect(() => (open ? onScrollMove(document, () => change(false)) : undefined), [open, change]);
  return { open, change };
}
