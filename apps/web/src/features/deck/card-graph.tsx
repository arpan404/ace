import { CheckIcon, LockSimpleIcon } from "@phosphor-icons/react";
import { cn } from "cn";
import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { ProviderMark } from "@/components/ui/provider-mark.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import {
  cardColumns,
  cardStatus,
  type CardMark,
  type CardTone,
  type DeckCard,
  type DeckRun,
} from "./deck-model.ts";

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
  const count = Math.max(columns.length, 1);
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
      for (const card of cards) {
        const to = nodes.get(card.id)?.getBoundingClientRect();
        for (const dependency of card.dependencies) {
          const from = nodes.get(dependency)?.getBoundingClientRect();
          if (!from || !to) continue;
          const x1 = from.right - box.left;
          const y1 = from.top + from.height / 2 - box.top;
          const x2 = to.left - box.left;
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
    <div
      ref={container}
      className="relative mt-3.5 grid gap-[18px]"
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
    >
      <svg aria-hidden className="pointer-events-none absolute inset-0 size-full overflow-visible">
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
      {Array.from({ length: count }, (_, index) => (
        <section
          key={index}
          aria-label={props.run.stages[index] ?? `Stage ${index + 1}`}
          className="relative z-[1] flex flex-col gap-3"
        >
          <h3 className="px-0.5 pb-0.5 text-xs font-medium text-subtle-foreground">
            {props.run.stages[index] ?? `Stage ${index + 1}`}
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
    </div>
  );
}

function CardTile(props: { card: DeckCard; run: DeckRun; selected: boolean; onSelect(): void }) {
  const status = cardStatus(props.card, props.run);
  const provider = props.card.lane?.worker.provider;
  return (
    <button
      data-card-id={props.card.id}
      type="button"
      aria-pressed={props.selected}
      onClick={props.onSelect}
      className={cn(
        "rounded-card bg-card px-3.5 py-3 text-left shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-[box-shadow,background-color] duration-200",
        "hover:bg-[color-mix(in_oklab,var(--card),var(--foreground)_3%)] focus-visible:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ring)_60%,transparent)]",
        props.selected &&
          "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ring)_60%,transparent),0_0_0_3px_color-mix(in_oklab,var(--ring)_12%,transparent)]",
        props.card.kind === "merge" && props.card.state === "merge" && "opacity-75",
      )}
    >
      <span className="block text-[13.5px] leading-[1.3] font-medium tracking-[-0.005em]">
        {props.card.title}
      </span>
      <span className="mt-2 flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <StatusMark mark={status.mark} tone={status.tone} />
        <span>{status.label}</span>
        {provider && <ProviderMark provider={provider} className="ml-auto" />}
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
    case "lock":
      return <Icon icon={LockSimpleIcon} size={14} />;
    case "spinner":
      return <Spinner />;
    case "dot":
      return <span aria-hidden className={cn("size-1.5 rounded-full", dotTone[props.tone])} />;
  }
}
