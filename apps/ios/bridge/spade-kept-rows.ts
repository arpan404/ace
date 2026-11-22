import type { SpadeBubbleRow } from "./spade-rows.ts";

/*
 * A conversation drawn from the events this phone kept (`spade-kept-events.ts`) before Spade has
 * answered: its words show, but nothing in it reads as still going, waiting on the person or
 * done, since any of that may have changed since. Pure.
 */

/**
 * The rows as kept: a reply that was being written shows its words, no longer writing; an
 * approval or an unsettled card (which may have been answered elsewhere) and the workers' rows
 * (whose states come from live reads) wait for Spade.
 */
export function spadeKeptRows<T extends { key: string; row: SpadeBubbleRow }>(
  rows: readonly T[],
): T[] {
  return rows.flatMap((each): T[] => {
    const { row } = each;
    if (row.kind === "ask" || row.kind === "workers") return [];
    if (row.kind === "question" && row.standing !== "settled") return [];
    if (row.kind === "bot" && row.live) return [{ ...each, row: { ...row, live: false } }];
    return [each];
  });
}

/** The conversation's head as kept: nothing answers or works until Spade says so. */
export function spadeKeptHead<T extends { answering: boolean; working: unknown }>(head: T): T {
  return { ...head, answering: false, working: null };
}
