import { ArrowRightIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { cn } from "@/lib/cn.ts";
import { ProviderMark } from "@/components/ui/provider-glyph.tsx";
import { cardStatus, type DeckRun } from "@ace/ui-core";
import { StatusMark } from "./card-graph.tsx";

/**
 * Lanes: every card of the plan as a table row, with its worker, reviewer and latest round.
 * Cards whose lane hasn't started are listed dimmed, so Lanes covers the same set as Plan. The
 * columns live on the list and the rows are subgrids, so every row's columns line up.
 */
export function LanesTab(props: { run: DeckRun; onOpen(cardId: string): void }) {
  const cards = props.run.cards;
  if (!cards.length)
    return (
      <EmptyState
        title="No lanes yet"
        description="Lanes start once the plan is approved and a card's dependencies merge."
      />
    );
  return (
    <ul
      aria-label="Lanes"
      className="mt-6 grid grid-cols-[minmax(0,1.2fr)_max-content_minmax(0,1.4fr)] gap-x-4"
    >
      {cards.map((card) => {
        const status = cardStatus(card, props.run);
        const lane = card.lane;
        const latest = lane?.rounds.at(-1);
        const summary = latest ? `${latest.label} · ${latest.verdict}` : card.note;
        return (
          <li key={card.id} className="col-span-3 grid grid-cols-subgrid border-t last:border-b">
            <button
              type="button"
              onClick={() => props.onOpen(card.id)}
              className={cn(
                "col-span-3 grid grid-cols-subgrid items-center rounded-md px-2 py-3 text-left transition-[background-color,opacity] duration-(--dur-1) hover:bg-accent",
                !lane && "opacity-55 hover:opacity-100",
              )}
            >
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-medium">{card.title}</span>
                <span className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  <StatusMark mark={status.mark} tone={status.tone} />
                  {status.label}
                </span>
              </span>
              {/* Who works and who reviews, always in full; the round summary wraps instead. */}
              <span className="flex items-center gap-1.5 text-sm whitespace-nowrap text-muted-foreground">
                {lane ? (
                  <>
                    {lane.worker?.provider && <ProviderMark provider={lane.worker.provider} />}
                    <span>{lane.worker?.account ?? "No worker"}</span>
                    <Icon icon={ArrowRightIcon} size={12} className="text-subtle-foreground" />
                    <span>{lane.reviewer?.account ?? "No reviewer yet"}</span>
                  </>
                ) : (
                  <span className="text-subtle-foreground">
                    {card.state === "merged" ? "Merged" : "Not dealt yet"}
                  </span>
                )}
              </span>
              {/* The summary wraps to two lines; the full text is in the tooltip and the lane. */}
              <span
                title={summary}
                className="line-clamp-2 text-sm leading-[1.4] text-muted-foreground"
              >
                {latest ? (
                  <>
                    <span className="text-foreground">{latest.label}</span> · {latest.verdict}
                  </>
                ) : (
                  summary
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
