import { expect, test } from "vitest";
import { Item } from "@ace/protocol";
import { portableContext } from "./index.ts";

function message(id: string, text: string, complete = true) {
  return Item.parse({
    id,
    agentId: "root",
    type: "message",
    role: "assistant",
    complete,
    createdAt: 1,
    parts: [{ type: "text", text }],
  });
}
test("Cursor portable context uses byte-budgeted recent complete citations and shared paging pointers", () => {
  const result = portableContext(
    {
      threadId: "cursor-source",
      provider: "cursor",
      backend: "cursor-sdk",
      throughSeq: 50,
      totalItems: 4,
    },
    [
      message("large", "😀".repeat(4000)),
      message("selected", "recent useful context"),
      message("pending", "unfinished", false),
    ],
    { maxBytes: 2048, maxItems: 3, historyTruncated: true },
  );
  const manifest = result.handoff;
  expect(result.bytes).toBe(Buffer.byteLength(result.text));
  expect(result.bytes).toBeLessThanOrEqual(2048);
  expect(result.truncated).toBe(true);
  expect(manifest.origin).toEqual({ provider: "cursor", backend: "cursor-sdk" });
  expect(manifest.excerpts).toEqual([
    {
      citation: { threadId: "cursor-source", itemId: "selected" },
      text: "assistant: recent useful context",
    },
  ]);
  expect(manifest.omittedItems).toBe(3);
  expect(manifest.history.tool).toBe("handoff_read");
  expect(manifest.history.before).toBe(51);
  expect(result.text).toContain("assistant: recent useful context");
});
function* history() {
  yield message("first", "bounded");
  yield message("extra", "overflow");
  throw new Error("must not scan the rest of history");
}
test("Cursor's handoff bounds iterator consumption and reports unread history", () => {
  const result = portableContext(
    { threadId: "source", provider: "cursor", throughSeq: 2, totalItems: 2 },
    history(),
    {
      maxItems: 1,
      maxBytes: 1024,
      historyTruncated: false,
    },
  );
  expect(result.truncated).toBe(true);
  expect(result.handoff.omittedItems).toBe(1);
});

test("identical completed messages retain distinct citations in portable Cursor history", () => {
  const result = portableContext(
    { threadId: "source", provider: "cursor", backend: "acp", throughSeq: 2, totalItems: 2 },
    [message("first", "same"), message("second", "same")],
    { maxBytes: 4096, maxItems: 5, historyTruncated: false },
  );
  const manifest = result.handoff;
  expect(manifest.excerpts).toEqual([
    { citation: { threadId: "source", itemId: "first" }, text: "assistant: same" },
    { citation: { threadId: "source", itemId: "second" }, text: "assistant: same" },
  ]);
  expect(result.truncated).toBe(false);
});
