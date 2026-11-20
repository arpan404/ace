import { useMemo, useState } from "react";

/** Rows picked in the tree, and the row a Shift range starts from. */
interface Picked {
  keys: readonly string[];
  anchor: string | undefined;
}

/** A pick holds only while the file it was made beside is still the one showing. */
interface Held extends Picked {
  current: string | undefined;
}

/** `keys` in the order the tree shows them, dropping any no longer shown. */
function inOrder(order: readonly string[], keys: ReadonlySet<string>): string[] {
  return order.filter((key) => keys.has(key));
}

/** The rows from `anchor` to `key`, both included, in the tree's order. */
function range(order: readonly string[], anchor: string | undefined, key: string): string[] {
  const end = order.indexOf(key);
  const start = anchor === undefined ? -1 : order.indexOf(anchor);
  if (end < 0) return [];
  if (start < 0) return [key];
  return order.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/**
 * The tree's selection, as in VS Code and Finder: one row by default (the file showing), a
 * plain pick selects one row, Ctrl/⌘ toggles a row, Shift selects a range from the last
 * picked row. Opening another file from elsewhere starts over from it.
 */
export function useTreeSelection(order: readonly string[], current: string | undefined) {
  const [held, hold] = useState<Held>();
  const picked = held?.current === current ? held : undefined;
  const setPicked = (next: Picked) => hold({ ...next, current });
  const keys = useMemo(() => {
    const chosen = picked ? picked.keys : current ? [current] : [];
    return new Set(inOrder(order, new Set(chosen)));
  }, [picked, current, order]);
  const anchor = picked?.anchor ?? current;
  return {
    /** Every selected row, in the tree's order. */
    keys,
    has: (key: string) => keys.has(key),
    only: (key: string) => setPicked({ keys: [key], anchor: key }),
    toggle: (key: string) => {
      const next = new Set(keys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setPicked({ keys: [...next], anchor: key });
    },
    /** Select from the anchor to `key`, keeping the anchor for the next range. */
    extend: (key: string) => setPicked({ keys: range(order, anchor, key), anchor }),
    all: () => setPicked({ keys: order, anchor }),
  };
}

export type TreeSelection = ReturnType<typeof useTreeSelection>;
