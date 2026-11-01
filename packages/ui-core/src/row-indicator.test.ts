import { expect, test } from "vitest";
import { rowAttention, type RowAttentionInput } from "./row-attention.ts";
import { rowIndicator } from "./row-indicator.ts";

const mark = (input: Pick<RowAttentionInput, "tone" | "word"> & Partial<RowAttentionInput>) =>
  rowIndicator(rowAttention({ unread: false, settled: false, ...input }))?.kind;

test("a request shows the needs-you dot, a fresh failure the failed dot", () => {
  expect(mark({ tone: "needs-you", word: "Approve" })).toBe("needs-you");
  expect(mark({ tone: "failed", word: "Failed", unread: true })).toBe("failed");
});

test("finished work shows the unread dot only until it is seen", () => {
  expect(mark({ tone: "done", word: "Done", unread: true })).toBe("unread");
  expect(mark({ tone: "done", word: "Done", unread: false })).toBeUndefined();
});

test("work still going on in the tree shows the live mark, never the finished dot", () => {
  // Unread or not, a thread whose agents still work or wait is live.
  expect(mark({ tone: "working", word: "Working", unread: true })).toBe("live");
  expect(mark({ tone: "waiting", word: "Waiting", unread: true })).toBe("live");
  expect(mark({ tone: "background", word: "Background", unread: true })).toBe("live");
});

test("a seen failure, a settled thread and a copy still syncing carry no mark", () => {
  expect(mark({ tone: "failed", word: "Failed", unread: false })).toBeUndefined();
  expect(mark({ tone: "done", word: "Done", unread: true, settled: true })).toBeUndefined();
});
