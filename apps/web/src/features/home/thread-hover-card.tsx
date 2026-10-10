import { useCallback, useEffect, useId, useState } from "react";
import type { ThreadListEntry } from "@ace/protocol";
import { modelLabel, providerDisplayName, type ThreadCard } from "@ace/ui-core";
import { GitBranchIcon } from "@phosphor-icons/react";
import { HoverCardContent } from "@/components/ui/hover-card.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { useAccountViews } from "@/lib/account-views.ts";
import { ProjectMark, PullRequest } from "./row-parts.tsx";

/** Metadata already in the row and shared account cache; no history or per-thread fetch. */
export function ThreadHoverContent(props: {
  card: ThreadCard;
  entry: ThreadListEntry;
  icon: string | null | undefined;
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
      side="bottom"
      align="start"
      aria-label={`Details for ${card.title}`}
      className="w-[280px] max-w-[calc(100vw-24px)] max-h-[min(400px,calc(100dvh-24px))] space-y-2 overflow-y-auto px-3 py-2.5 break-words"
    >
      <p className="text-ui leading-4 font-semibold text-foreground">{card.title}</p>
      <div className="space-y-1.5 text-xs leading-4 text-muted-foreground">
        <div className="flex items-center gap-2">
          <ProjectMark badge={card.badge} icon={props.icon} />
          <span>{card.project}</span>
        </div>
        <div className="flex items-center gap-2">
          <MachineMark icon={card.machineIcon} />
          <span>{card.machine ?? "This machine"}</span>
        </div>
        {card.branch && (
          <div className="flex items-start gap-2">
            <GitBranchIcon aria-hidden size={14} className="mt-px shrink-0" />
            <span>{card.branch.name}</span>
          </div>
        )}
        <div className="flex items-start gap-2">
          <ProviderIcon
            provider={card.provider}
            acpAgentId={card.acpAgentId}
            size={14}
            decorative
          />
          <span>
            {providerDisplayName(card.provider, card.acpAgentId)}
            {account ? ` · ${account.label}${queued ? " (queued)" : ""}` : ""}
            {card.subagents > 0 && (
              <span
                className="ml-2 whitespace-nowrap"
                aria-label={`${card.subagents} subagents running`}
              >
                ⑂ {card.subagents}
              </span>
            )}
          </span>
        </div>
        {model && (
          <p className="pl-[22px]" data-model={model} aria-label={`Model: ${modelLabel(model)}`}>
            {modelLabel(model)}
          </p>
        )}
        {(card.pr !== undefined || card.diff) && (
          <div className="flex flex-wrap items-center gap-3 pt-0.5">
            {card.prs?.length
              ? card.prs.map((pr) => (
                  <div
                    key={`${pr.repo.host}/${pr.repo.owner}/${pr.repo.name}/${pr.number}`}
                    className="flex w-full min-w-0 items-center gap-2"
                  >
                    <PullRequest
                      card={{ ...card, pr: pr.number, prState: pr.state, prs: undefined }}
                    />
                    <span className="min-w-0 truncate" title={pr.title}>
                      {pr.title}
                    </span>
                  </div>
                ))
              : card.pr !== undefined && <PullRequest card={card} />}
            {card.diff && (
              <span
                role="img"
                aria-label={`${card.diff.added} lines added, ${card.diff.removed} lines removed`}
                className="inline-flex gap-1.5 tabular-nums"
              >
                <span className="text-status-done">+{card.diff.added}</span>
                <span className="text-status-failed">−{card.diff.removed}</span>
              </span>
            )}
          </div>
        )}
      </div>
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
