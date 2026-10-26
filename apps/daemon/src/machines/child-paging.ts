import type { ChildLedger, ChildRow } from "./child-ledger.ts";

/*
 * Which unsettled children on other machines one poll reads (ADR 0099). However many there are,
 * every one is read in turn: each machine's children read longest ago go first, and machines
 * left out of a poll go first in the next, within a fixed number of status calls per poll.
 */

/** Children per status call, the call's own limit. */
export const STATUS_IDS_PER_CALL = 16;
/** Status calls one poll makes for unsettled children, across all machines. */
export const STATUS_CALLS_PER_POLL = 16;
/** Unsettled children read on one machine per poll, so one machine never takes every call. */
export const UNSETTLED_PER_MACHINE = 64;

/** Rows grouped by machine, at most one status call's worth in each batch. */
export function statusBatches(rows: readonly ChildRow[]): [string, ChildRow[]][] {
  const batches: [string, ChildRow[]][] = [];
  const open = new Map<string, ChildRow[]>();
  for (const row of rows) {
    let batch = open.get(row.machine);
    if (!batch || batch.length >= STATUS_IDS_PER_CALL) {
      batch = [];
      open.set(row.machine, batch);
      batches.push([row.machine, batch]);
    }
    batch.push(row);
  }
  return batches;
}

/**
 * The unsettled children this poll reads, by machine, each marked read in `turn` as it is
 * chosen so the next poll moves on to the ones left out.
 */
export function unsettledPage(ledger: ChildLedger, turn: number): [string, ChildRow[]][] {
  const page: [string, ChildRow[]][] = [];
  let calls = 0;
  for (const machine of ledger.unsettledMachines()) {
    const room = Math.min(
      UNSETTLED_PER_MACHINE,
      (STATUS_CALLS_PER_POLL - calls) * STATUS_IDS_PER_CALL,
    );
    if (room <= 0) break;
    const rows = ledger.unsettledTurn(machine, room);
    ledger.markRechecked(
      rows.map((row) => row.id),
      turn,
    );
    calls += Math.ceil(rows.length / STATUS_IDS_PER_CALL);
    if (rows.length) page.push([machine, rows]);
  }
  return page;
}
