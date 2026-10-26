import type { ChildLedger, ChildRow } from "./child-ledger.ts";

/*
 * Which unsettled children on other machines one poll reads (ADR 0099). However many there are,
 * every one is read in turn, within a fixed number of status calls per poll.
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
 * The unsettled children this poll reads, by machine. Machines served longest ago go first, so
 * one left out of a poll goes first in the next however busy the others are; each is read from
 * where it stopped, wrapping, so every child comes round. The work is bounded by the call budget,
 * never by how many children are active: a few indexed pages and one write per machine served.
 */
export function unsettledPage(ledger: ChildLedger, turn: number): [string, ChildRow[]][] {
  const page: [string, ChildRow[]][] = [];
  let calls = 0;
  for (const { machine, after } of ledger.machinesDue(STATUS_CALLS_PER_POLL)) {
    const room = Math.min(
      UNSETTLED_PER_MACHINE,
      (STATUS_CALLS_PER_POLL - calls) * STATUS_IDS_PER_CALL,
    );
    if (room <= 0) break;
    const rows = ledger.unsettledAfter(machine, after, room);
    const last = rows.at(-1);
    if (!last) {
      ledger.untrack(machine);
      continue;
    }
    ledger.markServed(machine, turn, last.id);
    calls += Math.ceil(rows.length / STATUS_IDS_PER_CALL);
    page.push([machine, rows]);
  }
  return page;
}
