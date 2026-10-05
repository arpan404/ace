import { CheckIcon, GitMergeIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "@/components/icon.tsx";
import { ProviderIconTip } from "@/components/ui/provider-icons.tsx";
import {
  cardColumns,
  cardStatus,
  deckMerge,
  planEnds,
  type CardMark,
  type CardTone,
  type DeckCard,
  type DeckRun,
} from "@ace/ui-core";
import { Spinner } from "@/components/ui/spinner.tsx";

/** Edges stop this far short of a card, so they meet its edge rather than run over its border. */
const edgeGap = 4;
const mergeId = "deck:merge";
/** Past this many stages, columns keep a fixed width and the plan scrolls sideways. */
const fixedAfter = 4;

interface Edge {
  key: string;
  d: string;
  hot: boolean;
}

/** A column's cards, with merged ones folded into one chip when `collapse` is on. */
type Slot = { card: DeckCard } | { merged: DeckCard[] };

function slots(column: readonly DeckCard[], collapse: boolean): Slot[] {
  if (!collapse) return column.map((card) => ({ card }));
  const merged = column.filter((card) => card.state === "merged");
  const rest = column.filter((card) => card.state !== "merged");
  return [
    ...(merged.length > 1 ? [{ merged }] : merged.map((card) => ({ card }))),
    ...rest.map((card) => ({ card })),
  ];
}

/**
 * The plan as cards in dependency columns with curved edges between them, ending in the merge.
 * Arrow keys move between cards (↑↓ within a stage, ←→ to the nearest card of the next or
 * previous one, Home and End to the ends), Enter selects, and Esc returns to the heading.
 */
export function CardGraph(props: {
  run: DeckRun;
  selected: string | undefined;
  onSelect(cardId: string): void;
  /** Fold each stage's merged cards into one "n merged" chip. */
  collapseMerged?: boolean;
  /** Esc leaves the graph: focus goes back to its heading. */
  onEscape?(): void;
}) {
  const columns = cardColumns(props.run.cards);
  const merge = deckMerge(props.run);
  const showMerge = props.run.cards.length > 0;
  const stages = Math.max(columns.length, 1);
  const container = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [overflow, setOverflow] = useState(false);
  const [focus, setFocus] = useState<string>();
  const { cards } = props.run;
  const selected = props.selected;
  const collapse = props.collapseMerged ?? false;
  const columnSlots = columns.map((column) => slots(column, collapse));
  const visible = columnSlots.flatMap((column) =>
    column.flatMap((slot) => ("card" in slot ? [slot.card.id] : [])),
  );
  // One card in the graph is a tab stop: the one last focused, else the selection.
  const stop = focus && visible.includes(focus) ? focus : (selected ?? visible[0]);
  const titles = new Map(cards.map((card) => [card.id, card.title]));

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    let frame = 0;
    const draw = () => {
      frame = 0;
      const box = root.getBoundingClientRect();
      const nodes = new Map<string, HTMLElement>();
      for (const node of root.querySelectorAll<HTMLElement>("[data-card-id]"))
        for (const id of node.dataset.cardId?.split(" ") ?? []) nodes.set(id, node);
      const next: Edge[] = [];
      const targets = [
        ...cards.map((card) => ({ id: card.id, dependencies: card.dependencies })),
        { id: mergeId, dependencies: planEnds(cards) },
      ];
      const seen = new Set<string>();
      for (const card of targets) {
        const target = nodes.get(card.id);
        const to = target?.getBoundingClientRect();
        for (const dependency of card.dependencies) {
          const source = nodes.get(dependency);
          const from = source?.getBoundingClientRect();
          if (!from || !to || source === target) continue;
          // Folded cards share one chip: draw its edge to a target once.
          const key = `${source?.dataset.cardId}-${card.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const x1 = from.right - box.left + edgeGap;
          const y1 = from.top + from.height / 2 - box.top;
          const x2 = to.left - box.left - edgeGap;
          const y2 = to.top + to.height / 2 - box.top;
          const mid = (x1 + x2) / 2;
          next.push({
            key,
            d: `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`,
            hot: dependency === selected || card.id === selected,
          });
        }
      }
      setEdges(next);
      const scroll = scroller.current;
      setOverflow(!!scroll && scroll.scrollWidth > scroll.clientWidth + 1);
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    draw();
    // The merge column sticks to the right edge while the plan scrolls: its edges follow it.
    const scroll = scroller.current;
    scroll?.addEventListener("scroll", later, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(later);
    observer?.observe(root);
    return () => {
      scroll?.removeEventListener("scroll", later);
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [cards, selected]);

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const root = container.current;
    const current = (event.target as HTMLElement).closest<HTMLElement>("[data-card-id]")?.dataset
      .cardId;
    if (!root || !current) return;
    const at = columnSlots.findIndex((column) =>
      column.some((slot) => "card" in slot && slot.card.id === current),
    );
    const column = (columnSlots[at] ?? []).flatMap((slot) =>
      "card" in slot ? [slot.card.id] : [],
    );
    const row = column.indexOf(current);
    const nearest = (stage: number) => {
      const ids = (columnSlots[stage] ?? []).flatMap((slot) =>
        "card" in slot ? [slot.card.id] : [],
      );
      const from = root.querySelector(`[data-card-id="${current}"]`)?.getBoundingClientRect();
      if (!from) return ids[0];
      const middle = from.top + from.height / 2;
      let best: string | undefined;
      let distance = Infinity;
      for (const id of ids) {
        const rect = root.querySelector(`[data-card-id="${id}"]`)?.getBoundingClientRect();
        if (!rect) continue;
        const gap = Math.abs(rect.top + rect.height / 2 - middle);
        if (gap < distance) {
          distance = gap;
          best = id;
        }
      }
      return best;
    };
    let next: string | undefined;
    switch (event.key) {
      case "ArrowDown":
        next = column[row + 1];
        break;
      case "ArrowUp":
        next = column[row - 1];
        break;
      case "ArrowRight":
        for (let stage = at + 1; stage < columnSlots.length && !next; stage++)
          next = nearest(stage);
        break;
      case "ArrowLeft":
        for (let stage = at - 1; stage >= 0 && !next; stage--) next = nearest(stage);
        break;
      case "Home":
        next = visible[0];
        break;
      case "End":
        next = visible.at(-1);
        break;
      case "Escape":
        event.preventDefault();
        props.onEscape?.();
        return;
      default:
        return;
    }
    event.preventDefault();
    if (!next) return;
    setFocus(next);
    root.querySelector<HTMLElement>(`[data-card-id="${next}"]`)?.focus();
  };

  const width = stages > fixedAfter ? "220px" : "minmax(150px, 1fr)";
  return (
    // Narrow windows and long plans scroll sideways; the merge column stays in view.
    <div ref={scroller} className="mt-3.5 overflow-x-auto pb-1">
      <div
        ref={container}
        role="grid"
        aria-label="Plan"
        onKeyDown={move}
        className={cn(
          "relative grid gap-[18px]",
          stages > fixedAfter ? "w-max min-w-full" : "w-full",
        )}
        style={{
          gridTemplateColumns: `repeat(${stages}, ${width})${showMerge ? " minmax(140px, 180px)" : ""}`,
        }}
      >
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 size-full overflow-visible"
        >
          {edges.map((edge) => (
            <path
              key={edge.key}
              d={edge.d}
              fill="none"
              strokeWidth={1.5}
              className={
                edge.hot
                  ? "stroke-[color-mix(in_oklab,var(--ring)_55%,transparent)]"
                  : "stroke-border opacity-50"
              }
            />
          ))}
        </svg>
        {Array.from({ length: stages }, (_, index) => (
          <div
            key={index}
            role="row"
            aria-label={`Stage ${index + 1}`}
            className="relative z-[1] flex flex-col gap-3"
          >
            <div role="rowheader">
              <h3 className="px-0.5 pb-0.5 text-xs font-medium text-muted-foreground">
                Stage {index + 1}
              </h3>
            </div>
            {(columnSlots[index] ?? []).map((slot) =>
              "card" in slot ? (
                <div role="gridcell" key={slot.card.id}>
                  <CardTile
                    card={slot.card}
                    run={props.run}
                    selected={slot.card.id === props.selected}
                    tabbable={slot.card.id === stop}
                    after={slot.card.dependencies.flatMap((id) => titles.get(id) ?? [])}
                    onFocus={() => setFocus(slot.card.id)}
                    onSelect={() => props.onSelect(slot.card.id)}
                  />
                </div>
              ) : (
                <div role="gridcell" key={`merged-${index}`}>
                  <span
                    data-card-id={slot.merged.map((card) => card.id).join(" ")}
                    className="flex items-center gap-1.5 rounded-card bg-card px-3.5 py-2.5 text-sm text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]"
                  >
                    <Icon icon={CheckIcon} size={14} />
                    {slot.merged.length} merged
                  </span>
                </div>
              ),
            )}
          </div>
        ))}
        {showMerge && (
          <div
            role="row"
            aria-label="Merge"
            className={cn("sticky right-0 z-[2] flex flex-col gap-3", overflow && "bg-background")}
          >
            {/* When the plan scrolls, a short fade says it continues under the merge column. */}
            {overflow && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 -left-4 w-4 bg-linear-to-l from-background"
              />
            )}
            <div role="rowheader">
              <h3 className="px-0.5 pb-0.5 text-xs font-medium text-muted-foreground">Merge</h3>
            </div>
            <div role="gridcell">
              <div
                data-card-id={mergeId}
                className="rounded-card bg-card px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--border)]"
              >
                <span className="flex items-center gap-1.5 text-ui leading-[1.3] font-medium">
                  <Icon icon={GitMergeIcon} size={14} className="text-muted-foreground" />
                  Merge
                </span>
                <span className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
                  {merge.done && <Icon icon={CheckIcon} size={14} />}
                  {merge.detail}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CardTile(props: {
  card: DeckCard;
  run: DeckRun;
  selected: boolean;
  tabbable: boolean;
  /** Titles of the cards it waits for. */
  after: readonly string[];
  onFocus(): void;
  onSelect(): void;
}) {
  const status = cardStatus(props.card, props.run);
  const provider = props.card.lane?.worker?.provider;
  const helpers = props.card.agents.filter((agent) => agent.nested && agent.live).length;
  const described = `${props.card.id}-after`;
  const tile = (
    <button
      data-card-id={props.card.id}
      type="button"
      aria-pressed={props.selected}
      aria-describedby={props.after.length ? described : undefined}
      tabIndex={props.tabbable ? 0 : -1}
      title={`${props.card.title} · ${status.label}`}
      onFocus={props.onFocus}
      onClick={props.onSelect}
      className={cn(
        "w-full rounded-card bg-card px-3.5 py-3 text-left shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-[box-shadow,background-color] duration-(--dur-2)",
        "hover:bg-[color-mix(in_oklab,var(--card),var(--foreground)_3%)]",
        // WP-1: focus-ring. Focus is a full ring around the card; selection is a tint and an
        // inner line, so the two never look alike.
        "focus-visible:shadow-[0_0_0_2px_var(--ring)]",
        props.selected && "bg-accent shadow-[inset_0_0_0_1.5px_var(--ring)]",
      )}
    >
      <span className="line-clamp-2 text-ui leading-[1.3] font-medium tracking-[-0.005em]">
        {props.card.title}
      </span>
      <span className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
        <StatusMark mark={status.mark} tone={status.tone} />
        <span className="min-w-0 truncate">{status.label}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {helpers > 0 && (
            <span className="text-muted-foreground tabular-nums">
              +{helpers} {helpers === 1 ? "sub-agent" : "sub-agents"}
            </span>
          )}
          {provider && <ProviderIconTip provider={provider} />}
        </span>
      </span>
    </button>
  );
  if (!props.after.length) return tile;
  return (
    <>
      {tile}
      {/* Outside the button: a description, not part of the card's name. */}
      <span id={described} className="sr-only">
        After {props.after.join(", ")}
      </span>
    </>
  );
}

const dotTone: Record<CardTone, string> = {
  idle: "bg-subtle-foreground",
  waiting: "bg-status-waiting",
  "needs-you": "bg-status-needs-you",
  working: "bg-status-working",
  done: "bg-status-done",
};

export function StatusMark(props: { mark: CardMark; tone: CardTone }) {
  switch (props.mark) {
    case "check":
      return <Icon icon={CheckIcon} size={14} />;
    case "spinner":
      return <Spinner />;
    case "dot":
      return (
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dotTone[props.tone])} />
      );
  }
}
