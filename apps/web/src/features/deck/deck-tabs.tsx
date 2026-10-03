import { ArrowRightIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { cn } from "@/lib/cn.ts";
import { ProviderMark } from "@/components/ui/provider-glyph.tsx";
import { cardStatus, type DeckRun, type Gate } from "@ace/ui-core";
import { StatusMark } from "./card-graph.tsx";

/** What a card without a lane yet is waiting for, for its row in Lanes. */
function waitsOn(card: DeckRun["cards"][number], run: DeckRun): string {
  const titles = card.dependencies.flatMap((id) => {
    const dependency = run.cards.find((c) => c.id === id);
    return dependency ? [dependency.title] : [];
  });
  return titles.length ? `Starts after ${titles.join(", ")}` : "Starts once the plan is approved";
}

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
        const summary = latest
          ? [latest.label, latest.verdict, latest.detail].filter(Boolean).join(" · ")
          : waitsOn(card, props.run);
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
                    <ProviderMark provider={lane.worker.provider} />
                    <span>{lane.worker.account}</span>
                    <Icon icon={ArrowRightIcon} size={12} className="text-subtle-foreground" />
                    <span>{lane.reviewer.account}</span>
                  </>
                ) : (
                  <span className="text-subtle-foreground">
                    {card.kind === "merge" ? "Merges once every lane passes" : "Not dealt yet"}
                  </span>
                )}
              </span>
              {/* The summary wraps to two lines; the full text is in the tooltip and the lane. */}
              <span title={summary} className="line-clamp-2 text-sm leading-[1.4] text-muted-foreground">
                {latest ? (
                  <>
                    <span className="text-foreground">{latest.label}</span> · {latest.verdict}
                    {latest.detail && ` · ${latest.detail}`}
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

const time = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Log: what the deck did, newest first. */
export function LogTab(props: { run: DeckRun }) {
  const entries = props.run.log.toReversed();
  return (
    <ol aria-label="Deck log" className="mt-6">
      {entries.map((entry) => (
        <li
          key={`${entry.at}-${entry.text}`}
          className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 border-t py-2.5 text-ui last:border-b"
        >
          <time
            dateTime={new Date(entry.at).toISOString()}
            className="text-subtle-foreground tabular-nums"
          >
            {time.format(entry.at)}
          </time>
          <span>{entry.text}</span>
        </li>
      ))}
    </ol>
  );
}

const changeLabel: Record<Gate["changes"][number]["kind"], string> = {
  moved: "Moved",
  added: "Added",
  removed: "Removed",
  changed: "Changed",
};

/** Right-panel tab: what a plan revision changes, card by card. */
export function PlanChanges(props: { gate: Gate | null }) {
  if (!props.gate?.changes.length)
    return (
      <EmptyState
        title="No plan changes"
        description="When the deck proposes a new plan revision, its changes appear here."
      />
    );
  return (
    <div className="h-full overflow-auto px-4 py-3">
      <h3 className="text-ui font-medium">Revision {props.gate.revision}</h3>
      <ul aria-label="Plan changes" className="mt-2">
        {props.gate.changes.map((change) => (
          <li key={`${change.kind}-${change.cardId}`} className="border-t py-2.5 text-ui">
            <span className="text-xs font-medium text-subtle-foreground">
              {changeLabel[change.kind]}
            </span>
            <div className="font-medium">{change.title}</div>
            <p className="mt-0.5 text-sm leading-[1.45] text-muted-foreground">{change.detail}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
