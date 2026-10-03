import { CheckIcon, GitMergeIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { ProviderMark } from "@/components/ui/provider-glyph.tsx";
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

interface Edge {
  key: string;
  d: string;
  hot: boolean;
}

/**
 * The plan as cards in dependency columns with curved edges between them. Selecting a card
 * shows its lane below and highlights its edges.
 */
export function CardGraph(props: {
  run: DeckRun;
  selected: string | undefined;
  onSelect(cardId: string): void;
}) {
  const columns = cardColumns(props.run.cards);
  const merge = deckMerge(props.run);
  const showMerge = props.run.cards.length > 0;
  const count = Math.max(columns.length, 1) + (showMerge ? 1 : 0);
  const container = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edge[]>([]);
  const { cards } = props.run;
  const selected = props.selected;

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const draw = () => {
      const box = root.getBoundingClientRect();
      const nodes = new Map<string, HTMLElement>();
      for (const node of root.querySelectorAll<HTMLElement>("[data-card-id]"))
        if (node.dataset.cardId) nodes.set(node.dataset.cardId, node);
      const next: Edge[] = [];
      const targets = [
        ...cards.map((card) => ({ id: card.id, dependencies: card.dependencies })),
        { id: mergeId, dependencies: planEnds(cards) },
      ];
      for (const card of targets) {
        const to = nodes.get(card.id)?.getBoundingClientRect();
        for (const dependency of card.dependencies) {
          const from = nodes.get(dependency)?.getBoundingClientRect();
          if (!from || !to) continue;
          const x1 = from.right - box.left + edgeGap;
          const y1 = from.top + from.height / 2 - box.top;
          const x2 = to.left - box.left - edgeGap;
          const y2 = to.top + to.height / 2 - box.top;
          const mid = (x1 + x2) / 2;
          next.push({
            key: `${dependency}-${card.id}`,
            d: `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`,
            hot: dependency === selected || card.id === selected,
          });
        }
      }
      setEdges(next);
    };
    draw();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(draw);
    observer.observe(root);
    return () => observer.disconnect();
  }, [cards, selected]);

  return (
    // Narrow windows scroll the plan sideways rather than crushing the cards.
    <div className="mt-3.5 overflow-x-auto pb-1">
      <div
        ref={container}
        className="relative grid gap-[18px]"
        style={{ gridTemplateColumns: `repeat(${count}, minmax(170px, 1fr))` }}
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
                  : "stroke-border"
              }
            />
          ))}
        </svg>
        {Array.from({ length: columns.length || 1 }, (_, index) => (
          <section
            key={index}
            aria-label={`Stage ${index + 1}`}
            className="relative z-[1] flex flex-col gap-3"
          >
            <h3 className="px-0.5 pb-0.5 text-xs font-medium text-subtle-foreground">
              Stage {index + 1}
            </h3>
            {/* The first column centres on its dependants, as the plan reads left to right. */}
            {index === 0 && <div aria-hidden className="flex-1" />}
            {(columns[index] ?? []).map((card) => (
              <CardTile
                key={card.id}
                card={card}
                run={props.run}
                selected={card.id === props.selected}
                onSelect={() => props.onSelect(card.id)}
              />
            ))}
            {index === 0 && <div aria-hidden className="flex-1" />}
          </section>
        ))}
        {showMerge && (
          <section aria-label="Merge" className="relative z-[1] flex flex-col gap-3">
            <h3 className="px-0.5 pb-0.5 text-xs font-medium text-subtle-foreground">Merge</h3>
            <div aria-hidden className="flex-1" />
            <div
              data-card-id={mergeId}
              className="rounded-card bg-card px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--border)]"
            >
              <span className="flex items-center gap-1.5 text-[13.5px] leading-[1.3] font-medium">
                <Icon icon={GitMergeIcon} size={14} className="text-muted-foreground" />
                Merge
              </span>
              <span className="mt-2 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                {merge.done && <Icon icon={CheckIcon} size={14} />}
                {merge.detail}
              </span>
            </div>
            <div aria-hidden className="flex-1" />
          </section>
        )}
      </div>
    </div>
  );
}

function CardTile(props: { card: DeckCard; run: DeckRun; selected: boolean; onSelect(): void }) {
  const status = cardStatus(props.card, props.run);
  const provider = props.card.lane?.worker?.provider;
  const helpers = props.card.agents.filter((agent) => agent.nested && agent.live).length;
  return (
    <button
      data-card-id={props.card.id}
      type="button"
      aria-pressed={props.selected}
      onClick={props.onSelect}
      className={cn(
        "rounded-card bg-card px-3.5 py-3 text-left shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-[box-shadow,background-color] duration-(--dur-2)",
        "hover:bg-[color-mix(in_oklab,var(--card),var(--foreground)_3%)] focus-visible:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ring)_60%,transparent)]",
        props.selected &&
          "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ring)_60%,transparent),0_0_0_3px_color-mix(in_oklab,var(--ring)_12%,transparent)]",
      )}
    >
      <span className="block text-[13.5px] leading-[1.3] font-medium tracking-[-0.005em]">
        {props.card.title}
      </span>
      <span className="mt-2 flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <StatusMark mark={status.mark} tone={status.tone} />
        <span>{status.label}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {helpers > 0 && (
            <span className="text-subtle-foreground tabular-nums">
              +{helpers} {helpers === 1 ? "sub-agent" : "sub-agents"}
            </span>
          )}
          {provider && <ProviderMark provider={provider} />}
        </span>
      </span>
    </button>
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
      return <span aria-hidden className={cn("size-1.5 rounded-full", dotTone[props.tone])} />;
  }
}
