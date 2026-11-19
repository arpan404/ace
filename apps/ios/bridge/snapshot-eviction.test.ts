import { expect, test } from "vitest";
import { NativeLedger, ledgerText } from "./native-ledger.ts";

/*
 * Deletion versus eviction evidence travels with removals. Rows carry their
 * creation sequence; ledger diffs preserve the last known sequence so the phone
 * can infer trimming (seq before itemsBefore) from canonical deletion.
 */

const itemPatch = (id: string, seq: number | null) => ({
  type: "thread.item",
  id,
  row: seq === null ? { text: id } : { text: id, creationSeq: seq },
  threadId: "thread",
  epoch: 1,
});

test("a ledger diff removal preserves the last known creation sequence", () => {
  const ledger = new NativeLedger("thread");
  ledger.delivered("thread:reset", { type: "thread.reset", epoch: 1 }, "");
  for (const [id, seq] of [
    ["a", 10],
    ["b", 11],
  ] as const)
    ledger.delivered(`thread:item:${id}`, itemPatch(id, seq), ledgerText(itemPatch(id, seq)));
  expect(ledger.begin()).toBe(true);
  ledger.touch("thread:item:a");
  const removals = ledger.close(2);
  expect(removals.map(([key]) => key)).toEqual(["thread:item:b"]);
  expect(removals[0]?.[1]()).toMatchObject({ type: "thread.item", id: "b", row: null, seq: 11 });
});
