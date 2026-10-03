import { ArrowRightIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ProviderMark } from "@/components/ui/provider-glyph.tsx";
import { StatusMark } from "./card-graph.tsx";
import { cardStatus, type DeckRun, type Gate } from "./deck-model.ts";

/** Lanes: every card that has a worker, with its reviewer and latest round. */
export function LanesTab(props: { run: DeckRun; onOpen(cardId: string): void }) {
  const lanes = props.run.cards.filter((card) => card.lane);
  if (!lanes.length)
    return (
      <EmptyState
        title="No lanes yet"
        description="Lanes start once the plan is approved and a card's dependencies merge."
      />
    );
  return (
    <ul aria-label="Lanes" className="mt-6 flex flex-col">
      {lanes.map((card) => {
        const status = cardStatus(card, props.run);
        const lane = card.lane;
        const latest = lane?.rounds.at(-1);
        return (
          <li key={card.id} className="border-t last:border-b">
            <button
              type="button"
              onClick={() => props.onOpen(card.id)}
              className="grid w-full grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-4 rounded-md px-2 py-3 text-left transition-colors duration-150 hover:bg-accent"
            >
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-medium">{card.title}</span>
                <span className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  <StatusMark mark={status.mark} tone={status.tone} />
                  {status.label}
                </span>
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                {lane && <ProviderMark provider={lane.worker.provider} />}
                <span className="truncate">{lane?.worker.account}</span>
                <Icon icon={ArrowRightIcon} size={12} className="text-subtle-foreground" />
                <span className="truncate">{lane?.reviewer.account}</span>
              </span>
              <span className="truncate text-sm text-muted-foreground">
                {latest && (
                  <>
                    <span className="text-foreground">{latest.label}</span> · {latest.verdict}
                    {latest.detail && ` · ${latest.detail}`}
                  </>
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
