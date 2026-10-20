import { useNavigate } from "@tanstack/react-router";
import { useSidebarAll } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import { formatSpan, providerDisplayName, threadCard, type ThreadCard } from "@ace/ui-core";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { useNow } from "@/lib/time.ts";
import { cn } from "@/lib/cn.ts";
import type { ForgePrDetail } from "@ace/protocol";
import { presenceLead, presenceWords } from "./pr-presence.ts";

const chip =
  "inline-flex h-6 max-w-56 min-w-0 shrink items-center gap-1.5 rounded-full px-1.5 text-xs text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover hover:text-foreground aria-expanded:bg-hover";

function Marks(props: { cards: readonly ThreadCard[] }) {
  const shown = props.cards.slice(0, 3);
  return (
    <span className="flex shrink-0 -space-x-1">
      {shown.map((card) => (
        <span
          key={card.id}
          className="grid size-4.5 place-items-center rounded-full bg-panel ring-1 ring-border"
        >
          <ProviderIcon
            provider={card.provider}
            acpAgentId={card.acpAgentId}
            size={12}
            decorative
          />
        </span>
      ))}
    </span>
  );
}

/**
 * Who is working on this PR: the provider mark of each linked task with the loudest one's
 * status and time. One task opens on click; several open a list. Nothing when none is linked.
 */
export function PrAgentChip(props: { detail: ForgePrDetail; compact?: boolean }) {
  const now = useNow();
  const navigate = useNavigate();
  const ids = props.detail.relatedThreads.filter((t) => !t.archived).map((t) => t.id);
  const entries =
    useSidebarAll((reader) =>
      ids.flatMap((id) => {
        const entry = reader.thread(id);
        return entry ? [entry] : [];
      }),
    ) ?? [];
  const cards = entries.map((entry: ThreadListEntry) =>
    threadCard({ entry, baseline: 0, settled: false, now }),
  );
  const lead = presenceLead(cards.map((card) => ({ card, tone: card.status.tone })))?.card;
  if (!lead) return null;
  const since = lead.status.since;
  const words = presenceWords(
    lead.status,
    since !== undefined ? formatSpan(since, now) : undefined,
  );
  const name = providerDisplayName(lead.provider, lead.acpAgentId);
  const label = `${name} · ${words}`;
  const body = (
    <>
      <Marks cards={cards} />
      <span
        aria-hidden
        data-tone={lead.status.tone}
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          lead.status.tone === "idle" ? "bg-faint-foreground" : "bg-(--tone)",
        )}
      />
      <span
        key={words}
        className={cn("fx-cross-in truncate @max-[32rem]/pr:sr-only", props.compact && "sr-only")}
      >
        {label}
      </span>
      {cards.length > 1 && (
        <span className="tabular-nums text-subtle-foreground">+{cards.length - 1}</span>
      )}
    </>
  );
  const open = (threadId: string) => void navigate({ to: "/t/$threadId", params: { threadId } });
  if (cards.length === 1)
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`${lead.title}: ${label}`}
              className={chip}
              onClick={() => open(lead.id)}
            />
          }
        >
          {body}
        </TooltipTrigger>
        <TooltipContent>{lead.title}</TooltipContent>
      </Tooltip>
    );
  return (
    <Menu>
      <MenuTrigger
        render={
          <button type="button" aria-label={`${cards.length} tasks: ${label}`} className={chip} />
        }
      >
        {body}
      </MenuTrigger>
      <MenuContent align="end" className="w-72">
        {cards.map((card) => (
          <MenuItem
            key={card.id}
            icon={
              <ProviderIcon
                provider={card.provider}
                acpAgentId={card.acpAgentId}
                size={14}
                decorative
              />
            }
            reason={card.status.label}
            onClick={() => open(card.id)}
          >
            {card.title}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
