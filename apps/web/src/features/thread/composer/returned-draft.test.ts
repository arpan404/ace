import {
  attachmentMarker,
  formatCodeAnnotations,
  formatMessageQuotes,
  takeAttachmentMarkers,
} from "@ace/ui-core";
import { expect, test } from "vitest";
import { draftFromMessage } from "./returned-draft.ts";

/*
 * A message taken back to edit (a failed held send, a failed send): its file markers come back
 * where the person put them, even when a quoted reply block went before the words.
 */

const quote = { id: "q1", text: "use the cache", before: "", after: "" };

test("a file in a message that replied to a quote comes back where it was in the words", () => {
  const block = `${formatMessageQuotes([quote]) ?? ""}\n\n`;
  const draft = draftFromMessage({
    input: [
      { type: "text", text: block },
      { type: "text", text: "see  now" },
    ],
    mentions: [],
    // Sent offsets count the quoted block before the words.
    files: [{ sha256: "s1", at: block.length + 4, name: "shot.png" }],
  });
  expect(draft.text).toBe(`see ${attachmentMarker} now`);
  expect(draft.tokens).toEqual([
    { start: 4, end: 5, label: "shot.png", attachment: { sha256: "s1" } },
  ]);
  expect(draft.quotes?.map((returned) => returned.text)).toEqual(["use the cache"]);
  // Sent again with no quote, it goes at the same words.
  expect(takeAttachmentMarkers(draft.text, draft.tokens ?? []).files).toEqual([
    { key: undefined, sha256: "s1", at: 4 },
  ]);
});

test("a file sent without a place comes back attached, with no marker", () => {
  const draft = draftFromMessage({
    input: [{ type: "text", text: "hello" }],
    mentions: [],
    files: [{ sha256: "s1", name: "a.txt" }],
  });
  expect(draft.text).toBe("hello");
  expect(draft.attachments).toEqual([{ sha256: "s1", name: "a.txt" }]);
});

test("a message with code annotations comes back with them as the draft's, not in its words", () => {
  const code = formatCodeAnnotations([
    {
      id: "c1",
      number: 1,
      path: "src/total.ts",
      start: { line: 1, column: 2 },
      end: { line: 2, column: 0 },
      excerpt: "let sum = 0;\n",
      comment: "Start at the first price",
      intent: "fix",
    },
  ]);
  const draft = draftFromMessage({
    input: [{ type: "text", text: `Please\n\n${code ?? ""}` }],
    mentions: [],
    files: [],
  });
  expect(draft.text).toBe("Please");
  expect(
    draft.annotations?.code?.map(({ path, start, end, comment, intent }) => ({
      path,
      start,
      end,
      comment,
      intent,
    })),
  ).toEqual([
    {
      path: "src/total.ts",
      start: { line: 1, column: 2 },
      end: { line: 2, column: 0 },
      comment: "Start at the first price",
      intent: "fix",
    },
  ]);
});
