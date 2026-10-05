import { expect, test } from "vitest";
import { hitSeq } from "./search-source.ts";

/** A thread's own search over `total` matches, 100 to a page, the wanted item at `at`. */
function threadWithMatches(total: number, at: number) {
  const asked: (string | undefined)[] = [];
  return {
    asked,
    client: {
      threadSearch: async (input: { cursor?: string | undefined }) => {
        asked.push(input.cursor);
        const start = input.cursor ? Number(input.cursor) : 0;
        const end = Math.min(start + 100, total);
        const hits = Array.from({ length: end - start }, (_, index) => {
          const n = start + index;
          return {
            threadId: "thread-1",
            itemId: n === at ? "item-wanted" : `item-${n}`,
            seq: 1_000 + n,
            turnOrdinal: null,
            snippet: { text: "", highlights: [] },
          };
        });
        return { hits, cursor: end < total ? String(end) : null };
      },
    },
  };
}

test("a hit past the first hundred matches still opens at its own item", async () => {
  const thread = threadWithMatches(250, 101);
  const seq = await hitSeq(
    thread.client as never,
    { threadId: "thread-1", itemId: "item-wanted" },
    "replay",
  );
  expect(seq).toBe(1_101);
  expect(thread.asked).toEqual([undefined, "100"]);
});

test("a hit whose item is gone opens the thread without a position", async () => {
  const thread = threadWithMatches(150, 999);
  expect(
    await hitSeq(thread.client as never, { threadId: "thread-1", itemId: "item-wanted" }, "x"),
  ).toBeUndefined();
  expect(thread.asked).toEqual([undefined, "100"]);
});
