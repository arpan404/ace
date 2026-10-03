import { expect, test } from "vitest";
import { Item, ThreadId } from "@ace/protocol";
import { handoffBytes, renderHandoff, selectHandoff } from "./index.ts";
const threadId = ThreadId.parse("source");
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
test("selection prioritizes recent complete items and restores conversation order", () => {
  const result = selectHandoff(
    {
      threadId,
      throughSeq: 30,
      totalItems: 4,
      items: [
        message("old", "o".repeat(1500)),
        message("middle", "m".repeat(600)),
        message("recent", "r".repeat(600)),
        message("streaming", "incomplete", false),
      ],
    },
    2048,
  );
  expect(result.excerpts.map((entry) => entry.citation.itemId)).toEqual(["middle", "recent"]);
  expect(result.omittedItems).toBe(2);
});
test("the serialized handoff respects its byte budget with Unicode and escaped text", () => {
  const result = selectHandoff(
    {
      threadId,
      throughSeq: 8,
      totalItems: 3,
      items: [
        message("large", "😀".repeat(4000)),
        message("escaped", '"\\\n'.repeat(1000)),
        message("small", "bounded"),
      ],
    },
    2048,
  );
  expect(handoffBytes(result)).toBeLessThanOrEqual(2048);
  expect(result.excerpts.map((entry) => entry.citation.itemId)).toEqual(["small"]);
  expect(result.omittedItems).toBe(2);
});
test("omitted historical pages remain reachable even when no excerpt fits", () => {
  const result = selectHandoff(
    { threadId, throughSeq: 900, totalItems: 999999, items: [message("large", "z".repeat(8000))] },
    2048,
  );
  expect(result.excerpts).toEqual([]);
  expect(result.omittedItems).toBe(999999);
  expect(result.history).toEqual({
    type: "items.page",
    tool: "ace_read_handoff",
    chunkTool: "ace_read_handoff_chunk",
    threadId,
    before: 901,
    limit: 50,
  });
  expect(JSON.parse(renderHandoff(result))).toMatchObject({
    sourceThreadId: threadId,
    lossy: true,
    limitations: expect.stringContaining("attachments"),
  });
});
test("tool and attachment context carries provenance and tells the reader how to retrieve details", () => {
  const artifact = Item.parse({
    id: "artifact",
    type: "artifact",
    source: "browser",
    path: "/artifact.png",
    mimeType: "image/png",
    bytes: 1,
    complete: true,
    createdAt: 1,
  });
  const result = selectHandoff(
    {
      threadId,
      throughSeq: 10,
      totalItems: 3,
      items: [
        message("message", "text"),
        Item.parse({
          id: "tool",
          agentId: "root",
          type: "tool_call",
          complete: true,
          createdAt: 1,
          call: {
            id: "tool",
            agentId: "root",
            kind: "shell",
            title: "Build",
            status: "succeeded",
            startedAt: 1,
            detail: { kind: "shell", command: "build" },
            raw: [],
          },
        }),
        artifact,
      ],
    },
    4096,
  );
  expect(result.excerpts[1]).toMatchObject({
    citation: { threadId, itemId: "tool" },
    text: expect.stringContaining("Tool Build: succeeded"),
  });
  expect(result.excerpts[2]).toMatchObject({
    citation: { threadId, itemId: "artifact" },
    text: expect.stringContaining("/artifact.png"),
  });
  expect(result.omittedItems).toBe(0);
  expect(result.limitations).toContain("full text, reasoning, tools and attachments");
});
