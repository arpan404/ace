import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import type { ThreadListEntry } from "@ace/protocol";
import { modelLabel, providerDisplayName, type ThreadCard } from "@ace/ui-core";
import { GitBranchIcon } from "@phosphor-icons/react";
import { HoverCardContent } from "@/components/ui/hover-card.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { useAccountViews } from "@/lib/account-views.ts";
import { ProjectMark, PullRequest } from "./row-parts.tsx";

/** One compact line of the card: a glyph and its fact. */
function Fact(props: { children: ReactNode }) {
  return <div className="flex h-7 min-w-0 items-center gap-2">{props.children}</div>;
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
      className="w-72 max-h-[min(var(--available-height),400px,calc(100dvh-24px))] overflow-y-auto px-3 py-2.5 break-words"
    >
      <p className="text-ui leading-5 font-medium text-foreground">{card.title}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {card.status.label} · {card.age}
      </p>
      <div className="mt-1.5 text-ui text-muted-foreground">
        <Fact>
          <ProjectMark badge={card.badge} />
          <span className="min-w-0 truncate">{card.project}</span>
        </Fact>
        <Fact>
          <MachineMark icon={card.machineIcon} />
          <span className="min-w-0 truncate">{card.machine ?? "This machine"}</span>
        </Fact>
        {card.branch && (
          <Fact>
            <GitBranchIcon aria-hidden size={14} className="shrink-0" />
            <span className="min-w-0 truncate" title={card.branch.name}>
              {card.branch.name}
            </span>
          </Fact>
        )}
        <Fact>
          <ProviderIcon
            provider={card.provider}
            acpAgentId={card.acpAgentId}
            size={14}
            decorative
          />
          <span className="shrink-0">
            {providerDisplayName(card.provider, card.acpAgentId)}
            {account ? ` · ${account.label}${queued ? " (queued)" : ""}` : ""}
          </span>
          {model && (
            <span
              className="min-w-0 truncate text-subtle-foreground"
              data-model={model}
              aria-label={`Model: ${modelLabel(model)}`}
            >
              {modelLabel(model)}
            </span>
          )}
          {card.subagents > 0 && (
            <span
              className="ml-auto shrink-0 tabular-nums"
              aria-label={`${card.subagents} subagents running`}
            >
              ⑂ {card.subagents}
            </span>
          )}
        </Fact>
      </div>
      {(card.pr !== undefined || card.diff) && (
        <div className="mt-1.5 border-t border-border pt-1.5 text-ui text-muted-foreground">
          {card.prs?.length
            ? card.prs.map((pr) => (
                <Fact key={`${pr.repo.host}/${pr.repo.owner}/${pr.repo.name}/${pr.number}`}>
                  <PullRequest
                    card={{ ...card, pr: pr.number, prState: pr.state, prs: undefined }}
                  />
                  {pr.title && (
                    <span className="min-w-0 truncate" title={pr.title}>
                      {pr.title}
                    </span>
                  )}
                </Fact>
              ))
            : card.pr !== undefined && (
                <Fact>
                  <PullRequest card={card} />
                </Fact>
              )}
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
  return { open, change };
}
