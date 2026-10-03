import { expect, it } from "vitest";
import { AgentId, ItemId, type Item } from "@ace/protocol";
import { portableContext } from "./index.ts";
const message = (text: string): Item => ({
  type: "message",
  id: ItemId.parse("item"),
  agentId: AgentId.parse("agent"),
  role: "assistant",
  complete: true,
  createdAt: 1,
  parts: [{ type: "text", text }],
  synthetic: false,
  raw: [],
});
it("bounds portable context, records source provenance and exposes loss without native stores", () => {
  const source = { threadId: "old-acp", provider: "cursor" as const, backend: "acp" };
  const result = portableContext(source, [message("summary"), message("x".repeat(1_000_000))], {
    maxBytes: 1024,
    maxItems: 10,
    historyTruncated: false,
  });
  expect(result.bytes).toBeLessThanOrEqual(1024);
  expect(result.truncated).toBe(true);
  expect(result.text).toContain("old-acp");
  expect(result.text).toContain("summary");
  expect(result.text).toContain("Context truncated: yes");
  expect(result.text).not.toContain("x".repeat(500));
});
it("makes identical source messages distinct context entries", () => {
  const result = portableContext(
    { threadId: "source", provider: "cursor" },
    [message("same"), message("same")],
    { maxBytes: 4096, maxItems: 5, historyTruncated: false },
  );
  expect(result.text.match(/assistant: same/g)).toHaveLength(2);
  expect(result.truncated).toBe(false);
});
