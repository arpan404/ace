import { expect, test } from "vitest";
import { historyWindowMetadata } from "./history-window-metadata.ts";

const a = { id: "a", items: ["answer-a"], first: 10, last: 10 };
const b = { id: "b", items: ["answer-b"], first: 20, last: 20 };
const c = { id: "c", items: ["answer-c"], first: 30, last: 30 };

test("canonical deletion at a window edge never becomes unloaded history", () => {
  expect(historyWindowMetadata([a, b], [b], (id) => id === "answer-a", 20, null)).toMatchObject({
    deleted: ["a"],
    evictedLeading: [],
    evictedTrailing: [],
    afterCount: 0,
  });
});

test("paging retains only blocks proven to lie outside the new sequence range", () => {
  expect(historyWindowMetadata([a, b], [b, c], () => false, 20, null)).toMatchObject({
    evictedLeading: ["a"],
    deleted: [],
    blockSeqs: {
      a: { first: 10, last: 10 },
      b: { first: 20, last: 20 },
      c: { first: 30, last: 30 },
    },
  });
  expect(historyWindowMetadata([b, c], [a, b], () => false, 10, 20)).toMatchObject({
    evictedTrailing: ["c"],
    deleted: [],
    beforeCount: null,
    afterCount: null,
    blockSeqs: {
      a: { first: 10, last: 10 },
      b: { first: 20, last: 20 },
      c: { first: 30, last: 30 },
    },
  });
});

test("regrouped and unknown blocks cannot create phantom space", () => {
  const regrouped = { id: "new-work", items: ["answer-a", "answer-b"], first: 10, last: 20 };
  expect(historyWindowMetadata([a, b], [regrouped], () => false, null, null)).toMatchObject({
    deleted: ["a", "b"],
    evictedLeading: [],
    evictedTrailing: [],
    beforeCount: 0,
    afterCount: 0,
  });
  expect(
    historyWindowMetadata([{ id: "unknown", items: ["old"] }], [b], () => false, 20, null).deleted,
  ).toEqual(["unknown"]);
  expect(historyWindowMetadata([a], [], () => false, null, null).deleted).toEqual(["a"]);
});
