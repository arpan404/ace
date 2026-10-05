import { ArrowRightIcon, CaretDownIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { cn } from "@/lib/cn.ts";
import { ProviderIconTip } from "@/components/ui/provider-icons.tsx";
import { cardStatus, laneGroups, type DeckCard, type DeckRun } from "@ace/ui-core";
import { StatusMark } from "./card-graph.tsx";
import { LaneDetail } from "./lane-detail.tsx";

const columns = "grid-cols-1 sm:grid-cols-[minmax(0,1.2fr)_max-content_minmax(0,1.4fr)]";

/**
 * Lanes: every card of the plan as a table row, grouped by what it needs (needs you, working,
 * in review, planned, merged), with its worker, reviewer and latest round. A row opens its lane
 * in place; the card stays in the URL. Below `sm` each row stacks.
 */
export function LanesTab(props: {
  run: DeckRun;
  /** The card whose lane is open, from the URL. */
  open: string | undefined;
  onOpen(cardId: string | undefined): void;
}) {
  if (!props.run.cards.length)
    return (
      <EmptyState
        title="No lanes yet"
        description="Lanes start once the plan is approved and a card's dependencies merge."
      />
    );
  return (
    <div role="table" aria-label="Lanes" className={cn("mt-6 grid gap-x-4", columns)}>
      <div role="rowgroup" className="sr-only">
        <div role="row">
          <span role="columnheader">Card</span>
          <span role="columnheader">Worker → Reviewer</span>
          <span role="columnheader">Latest round</span>
        </div>
      </div>
      {laneGroups(props.run).map((group) => (
        <div
          key={group.label}
          role="rowgroup"
          aria-label={group.label}
          className="col-span-full grid grid-cols-subgrid"
        >
          <div role="row" className="col-span-full">
            <div role="cell" aria-colspan={3}>
              <h3 className="px-2 pt-4 pb-1.5 text-xs font-medium text-muted-foreground">
                {group.label} <span className="tabular-nums">· {group.cards.length}</span>
              </h3>
            </div>
          </div>
          {group.cards.map((card) => (
            <LaneRow
              key={card.id}
              card={card}
              run={props.run}
              open={props.open === card.id}
              onToggle={() => props.onOpen(props.open === card.id ? undefined : card.id)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function LaneRow(props: { card: DeckCard; run: DeckRun; open: boolean; onToggle(): void }) {
  const { card } = props;
  const status = cardStatus(card, props.run);
  const lane = card.lane;
  const latest = lane?.rounds.at(-1);
  const summary = latest ? `${latest.label} · ${latest.verdict}` : card.note;
  const detail = `lane-${card.id}`;
  return (
    <>
      <div role="row" className="col-span-full grid grid-cols-subgrid border-t">
        <span role="cell" className="col-span-full grid grid-cols-subgrid">
          <button
            type="button"
            aria-expanded={props.open}
            aria-controls={props.open ? detail : undefined}
            onClick={props.onToggle}
            className={cn(
              "col-span-full grid grid-cols-subgrid items-center gap-y-1 rounded-md px-2 py-3 text-left outline-none transition-[background-color,opacity] duration-(--dur-1) hover:bg-accent",
              // WP-1: focus-ring-inset
              "focus-visible:shadow-[inset_0_0_0_2px_var(--ring)]",
              !lane && !props.open && "opacity-60 hover:opacity-100",
            )}
          >
            <span className="flex min-w-0 items-start gap-1.5">
              <Icon
                icon={CaretDownIcon}
                size={12}
                className={cn(
                  "mt-1 shrink-0 text-muted-foreground transition-transform duration-(--dur-2) motion-reduce:transition-none",
                  !props.open && "-rotate-90",
                )}
              />
              <span className="min-w-0">
                <span title={card.title} className="block truncate text-ui font-medium">
                  {card.title}
                </span>
                <span className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                  <StatusMark mark={status.mark} tone={status.tone} />
                  {status.label}
                </span>
              </span>
            </span>
            {/* Who works and who reviews, always in full; the round summary wraps instead. */}
            <span className="flex min-w-0 flex-wrap items-center gap-1.5 pl-[18px] text-sm text-muted-foreground sm:flex-nowrap sm:pl-0 sm:whitespace-nowrap">
              {lane ? (
                <>
                  {lane.worker?.provider && <ProviderIconTip provider={lane.worker.provider} />}
                  <span>{lane.worker?.account ?? "No worker"}</span>
                  <Icon icon={ArrowRightIcon} size={12} className="text-muted-foreground" />
                  {lane.reviewer?.provider && <ProviderIconTip provider={lane.reviewer.provider} />}
                  <span>{lane.reviewer?.account ?? "No reviewer yet"}</span>
                </>
              ) : (
                <span>{card.state === "merged" ? "Merged" : "Not dealt yet"}</span>
              )}
            </span>
            {/* The summary wraps to two lines; the full text is in the tooltip and the lane. */}
            <span
              title={summary}
              className="line-clamp-2 pl-[18px] text-sm leading-[1.4] text-muted-foreground sm:pl-0"
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
        </span>
      </div>
      {props.open && (
        <div role="row" id={detail} className="col-span-full">
          <div role="cell" aria-colspan={3} className="pb-3">
            <LaneDetail key={card.id} card={card} run={props.run} className="mt-1" />
          </div>
        </div>
      )}
    </>
  );
}
