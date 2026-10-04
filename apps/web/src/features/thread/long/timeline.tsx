import { useThreadMeta } from "@ace/client-react";
import { digestFacts, formatCount, turnHeadline, turnOutcomeLabel, turnSpan } from "@ace/ui-core";
import { XIcon } from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Dot } from "@/components/ui/dot.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { keymap } from "@/lib/keymap.ts";
import { useNow } from "@/lib/time.ts";
import { DigestFacts } from "./digest-facts.tsx";
import { useWatched, type ThreadNav } from "./nav.tsx";
import { useTurnHead, useTurnSummary } from "./turn-index.ts";

/** Fixed row height: the list never measures, so a 100,000-turn thread scrolls at once. */
const rowHeight = 52;
const page = 10;
const optionId = (ordinal: number) => `turn-option-${ordinal}`;

/**
 * The thread's turns, oldest to newest, each with its digest: tools, files ±, failures,
 * approvals, subagents and how long it ran. Virtual and paged by blocks of the turn index, so
 * only the turns in view are read. ↑↓ move, Enter jumps the transcript to the turn, Esc closes.
 */
export function TurnsPanel(props: { nav: ThreadNav }) {
  const { nav } = props;
  const meta = useThreadMeta(nav.threadId);
  const settled = meta?.status.state === "done" || meta?.status.state === "new";
  const head = useTurnHead(nav.threadId, { live: !settled });
  const count = head?.count ?? 0;
  const current = useWatched(nav.currentTurn);
  const [active, setActive] = useState<number>();
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line react-compiler/incompatible-library
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: 6,
  });
  const shown = active ?? current ?? count;
  // Open on the turn being read, once the count is known.
  const placed = useRef(false);
  useLayoutEffect(() => {
    if (placed.current || !count) return;
    placed.current = true;
    virtualizer.scrollToIndex(Math.max(0, Math.min(count, shown) - 1), { align: "center" });
  }, [count, shown, virtualizer]);
  useEffect(() => list.current?.focus(), []);

  const move = (ordinal: number) => {
    const next = Math.max(1, Math.min(count, ordinal));
    setActive(next);
    virtualizer.scrollToIndex(next - 1, { align: "auto" });
  };
  const pick = (ordinal: number) => {
    setActive(ordinal);
    void nav.jump.toTurn(ordinal);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!count) return;
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(shown + 1),
      ArrowUp: () => move(shown - 1),
      PageDown: () => move(shown + page),
      PageUp: () => move(shown - page),
      Home: () => move(1),
      End: () => move(count),
      Enter: () => pick(shown),
      " ": () => pick(shown),
      Escape: () => nav.setTurnsOpen(false),
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    action();
  };

  return (
    <aside
      aria-label="Turns"
      className="glass fx-rise-in absolute top-3 right-4 z-[7] flex w-[340px] flex-col rounded-lg shadow-[var(--glass-shadow)]"
      style={{ height: "min(70vh, 640px)" }}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 pr-1.5 pl-3">
        <h2 className="text-ui font-medium text-foreground">Turns</h2>
        <span className="text-xs tabular-nums text-subtle-foreground">
          {head ? formatCount(count) : ""}
        </span>
        {head && !head.ready && (
          <span className="flex items-center gap-1.5 text-xs text-subtle-foreground">
            <Spinner /> Indexing
          </span>
        )}
        <IconButton
          icon={XIcon}
          label="Close turns"
          size="sm"
          className="ml-auto"
          onClick={() => nav.setTurnsOpen(false)}
        />
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5">
        {head && !count ? (
          <p className="px-2.5 py-3 text-ui text-muted-foreground">No turns yet.</p>
        ) : (
          <div
            ref={list}
            role="listbox"
            aria-label="Turns of this thread"
            tabIndex={0}
            aria-activedescendant={count ? optionId(shown) : undefined}
            onKeyDown={onKeyDown}
            className="relative w-full rounded-md outline-none"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                className="absolute inset-x-0 top-0"
                style={{ height: rowHeight, transform: `translateY(${item.start}px)` }}
              >
                <TurnOption
                  threadId={nav.threadId}
                  ordinal={item.index + 1}
                  active={item.index + 1 === shown}
                  reading={item.index + 1 === current}
                  onPick={() => pick(item.index + 1)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="flex h-8 shrink-0 items-center gap-1.5 border-t border-border px-3 text-2xs text-subtle-foreground">
        <Kbd>↑↓</Kbd> move <Kbd>↵</Kbd> jump <Kbd keys={keymap.previousTurn.keys} />
        <Kbd keys={keymap.nextTurn.keys} /> between turns
      </p>
    </aside>
  );
}

function TurnOption(props: {
  threadId: string;
  ordinal: number;
  active: boolean;
  reading: boolean;
  onPick(): void;
}) {
  const summary = useTurnSummary(props.threadId, props.ordinal);
  const now = useNow();
  const facts = summary ? digestFacts(summary.digest) : [];
  const outcome = summary ? turnOutcomeLabel(summary.outcome) : undefined;
  return (
    // The list owns the keyboard (aria-activedescendant); options take the pointer.
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
    <div
      id={optionId(props.ordinal)}
      role="option"
      aria-selected={props.active}
      aria-label={
        summary
          ? `Turn ${props.ordinal}: ${turnHeadline(summary)}. ${outcome}${facts.length ? `, ${facts.map((fact) => fact.text).join(", ")}` : ""}`
          : `Turn ${props.ordinal}`
      }
      onClick={props.onPick}
      className={cn(
        "flex h-full cursor-pointer flex-col justify-center gap-0.5 rounded-md px-2.5 hover:bg-accent",
        props.active && "bg-accent",
        props.reading && "shadow-[inset_2px_0_0_var(--ring)]",
      )}
    >
      <span className="flex min-w-0 items-center gap-2 text-ui">
        <span className="shrink-0 font-mono text-xs tabular-nums text-subtle-foreground">
          {props.ordinal}
        </span>
        {summary?.outcome === "active" ? (
          <Spinner />
        ) : summary?.outcome === "failed" ? (
          <Dot tone="failed" label="Failed" />
        ) : summary?.digest.approvalsPending ? (
          <Dot tone="needs-you" label="Waiting on you" />
        ) : null}
        {summary ? (
          <span className="min-w-0 flex-1 truncate text-foreground">{turnHeadline(summary)}</span>
        ) : (
          <Skeleton className="h-3 w-40" />
        )}
        {summary && (
          <span className="shrink-0 text-xs tabular-nums text-subtle-foreground">
            {turnSpan(summary, now)}
          </span>
        )}
      </span>
      <span className="min-w-0 pl-[30px] text-xs text-subtle-foreground">
        {facts.length ? <DigestFacts facts={facts} /> : summary ? <span>{outcome}</span> : null}
      </span>
    </div>
  );
}
