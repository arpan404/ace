import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import type { Row } from "../transcript/rows.ts";
import type { Anchor } from "../transcript/scroll.ts";
import type { ThreadNav } from "./nav.tsx";

/** Where each turn starts among the rows. */
function turnStarts(rows: readonly Row[]): { index: number; ordinal: number }[] {
  const starts: { index: number; ordinal: number }[] = [];
  let previous: number | undefined;
  rows.forEach((row, index) => {
    const ordinal = row.ordinal;
    if (ordinal === undefined || ordinal === previous) return;
    starts.push({ index, ordinal });
    previous = ordinal;
  });
  return starts;
}

/**
 * ⌥⌘↑ and ⌥⌘↓: the previous and next turn. Within the rows it scrolls; past them it jumps
 * (a window of older history, or the live end after the last turn).
 */
export function TurnKeys(props: {
  rows: readonly Row[];
  anchor: { current: Anchor | undefined };
  nav: ThreadNav;
  scrollTo(index: number): void;
  toLive(): void;
}) {
  const { rows, anchor, nav } = props;
  const actions = props;
  const step = (direction: 1 | -1) => {
    const starts = turnStarts(rows);
    const top = anchor.current?.index ?? 0;
    const current = nav.currentTurn.get();
    if (direction === 1) {
      const next = starts.find((start) => start.index > top);
      if (next) return actions.scrollTo(next.index);
      const last = current ?? starts.at(-1)?.ordinal;
      const newest = nav.liveTurn.get();
      if (last !== undefined && newest !== undefined && last < newest)
        return void nav.jump.toTurn(last + 1);
      return actions.toLive();
    }
    const here = starts.findLast((start) => start.index <= top);
    const offset = anchor.current?.offset ?? 0;
    if (here && (here.index < top || offset < -8)) return actions.scrollTo(here.index);
    const previous = starts.findLast((start) => start.index < (here?.index ?? top));
    if (previous) return actions.scrollTo(previous.index);
    const first = here?.ordinal ?? current;
    if (first !== undefined && first > 1) void nav.jump.toTurn(first - 1);
  };
  useHotkey(keymap.nextTurn.keys, () => step(1));
  useHotkey(keymap.previousTurn.keys, () => step(-1));
  return null;
}
