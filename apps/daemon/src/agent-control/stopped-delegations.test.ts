import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadId } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { Store } from "../store.ts";
import { DelegationJournal, stoppedCallsKept } from "./journal.ts";

/*
 * The delegations a thread's Stops caught on their way (ADR 0191): kept refused across Stops,
 * until each arrives and is refused, and bounded per thread. Against a real store.
 */

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

function journal() {
  const home = mkdtempSync(join(tmpdir(), "ace-stopped-delegations-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new Store(join(home, "events.sqlite"), (error) => {
    throw error;
  });
  cleanup.push(() => void store.close());
  return new DelegationJournal(store);
}

const thread = ThreadId.parse("t-1");
const ids = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => `call-${from + index}`);

test("a delegation one Stop caught stays refused after later Stops", () => {
  const j = journal();
  j.fenceTurn(thread, "run-a", { stopSeq: 1, inFlight: ["from-a"] });
  j.fenceTurn(thread, "run-b", { stopSeq: 2, inFlight: ["from-b"] });
  j.fenceTurn(thread, "", { stopSeq: 3, inFlight: [] });
  expect(j.stoppedCall(thread, "from-a")).toBe(true);
  expect(j.stoppedCall(thread, "from-b")).toBe(true);
  // Arrived and refused: resolved.
  j.resolveStoppedCall(thread, "from-a");
  expect(j.stoppedCall(thread, "from-a")).toBe(false);
  expect(j.stoppedCall(thread, "from-b")).toBe(true);
});

test("a thread keeps refusing its newest stopped delegations, up to the bound", () => {
  const j = journal();
  // Many Stops, each catching as many calls as one Stop records.
  for (let stop = 0; stop < 6; stop++)
    j.fenceTurn(thread, `run-${stop}`, { stopSeq: stop + 1, inFlight: ids(stop * 64, 64) });
  const all = ids(0, 6 * 64);
  const kept = all.filter((id) => j.stoppedCall(thread, id));
  expect(kept).toEqual(all.slice(-stoppedCallsKept));
});
