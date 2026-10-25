import type { MachineThreadView } from "@ace/protocol";
import { settledStates } from "../agent-control/watch-view.ts";

/*
 * Settled children on other machines can start again there: the person on that machine sends
 * the thread new work. Pairing is one-way (ADR 0078: the target holds no route back), so the
 * caller re-checks recently settled children with the ordinary status call, within these bounds
 * (ADR 0099).
 */

/** Re-check settled children every this many polls (10 s at the default 1 s poll). */
export const RECHECK_POLLS = 10;
/** Only children settled this recently are re-checked. */
export const RECHECK_WINDOW_MS = 24 * 60 * 60 * 1000;
/** At most this many children per machine per re-check: one status call each. */
export const RECHECK_PER_MACHINE = 16;

/** The most recently settled children, at most `RECHECK_PER_MACHINE` per machine. */
export function recheckBatches<T extends { machine: string }>(
  recentFirst: readonly T[],
): Map<string, T[]> {
  const batches = new Map<string, T[]>();
  for (const row of recentFirst) {
    const batch = batches.get(row.machine) ?? [];
    if (batch.length >= RECHECK_PER_MACHINE) continue;
    batch.push(row);
    batches.set(row.machine, batch);
  }
  return batches;
}

/**
 * What a re-read view of a settled child means: it runs again (`reopen`), it ran again and
 * settled with a different result (`settle`, a new result for the parent), or nothing that
 * matters to the parent changed (`ignore`, so a title or pin there never repeats a result).
 */
export function recheckOutcome(
  saved: MachineThreadView | undefined,
  view: MachineThreadView,
): "reopen" | "settle" | "ignore" {
  if (!settledStates.has(view.state) || view.requests.length > 0) return "reopen";
  if (saved && saved.state === view.state && (saved.result ?? "") === (view.result ?? ""))
    return "ignore";
  return "settle";
}
