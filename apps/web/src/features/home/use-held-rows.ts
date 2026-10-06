import {
  holdOrder,
  homeRowKey,
  homeRowThread,
  ListHold,
  type Hold,
  type HomeRow,
  type Timers,
} from "@ace/ui-core";
import type { FocusEvent } from "react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

const browserTimers: Timers = {
  set(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/** Focus that came from the keyboard; a click that focuses a row doesn't hold the list. */
function keyboardFocus(target: EventTarget): boolean {
  if (!(target instanceof Element)) return false;
  try {
    return target.matches(":focus-visible");
  } catch {
    // An engine without :focus-visible: count any focus.
    return true;
  }
}

/**
 * Whether the Home list holds its order (UX audit TN-3), with the handlers for its viewport:
 * the pointer over it or keyboard focus in it holds the order, released 600 ms after both leave.
 */
export function useListHold(timers: Timers = browserTimers) {
  const [hold] = useState(() => new ListHold(timers));
  useEffect(() => () => hold.dispose(), [hold]);
  const state = useSyncExternalStore(hold.subscribe, hold.getState, hold.getState);
  const handlers = useMemo(
    () => ({
      onPointerEnter: () => hold.pointer(true),
      onPointerLeave: () => hold.pointer(false),
      onFocus: (event: FocusEvent) => hold.focus(keyboardFocus(event.target)),
      onBlur: (event: FocusEvent) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node && event.currentTarget.contains(next))) hold.focus(false);
      },
    }),
    [hold],
  );
  return { state, handlers };
}

/**
 * The rows to draw: `rows` itself while the list is free; while it holds, the rows in the places
 * they were drawn. A row that changes kind (pinned, settled) still moves, being the person's own
 * doing, as does the Pinned group, ordered by the person (a drag lands at once), and a row that
 * needs you rises once the pointer is off the list.
 */
export function useHeldRows(
  rows: readonly HomeRow[],
  hold: Hold,
  needsYou: readonly string[],
): readonly HomeRow[] {
  const [state, setState] = useState({ rows, hold, shown: rows });
  if (state.rows === rows && state.hold === hold) return state.shown;
  const rising = new Set(hold.rise ? needsYou : []);
  const shown = hold.held
    ? holdOrder(
        state.shown,
        rows,
        homeRowKey,
        (row, was) =>
          row.kind !== was.kind ||
          row.kind === "pinned" ||
          row.kind === "pinned-header" ||
          row.kind === "pinned-end" ||
          rising.has(homeRowThread(row) ?? ""),
      )
    : rows;
  // Adjusting state while rendering: the next render draws the held order straight away.
  setState({ rows, hold, shown });
  return shown;
}
