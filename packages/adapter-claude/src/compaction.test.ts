import { expect, test } from "vitest";
import { harness } from "./translator.test-helper.ts";

const summaryText =
  "This session is being continued from a previous conversation that ran out of context. " +
  "The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request";

/** The summary turn as Claude Code's stream-json writes it after a compaction. */
const summaryFrame = (extra: Record<string, unknown> = {}) => ({
  type: "user",
  message: { role: "user", content: [{ type: "text", text: summaryText }] },
  parent_tool_use_id: null,
  session_id: "s",
  uuid: "summary-uuid",
  isSynthetic: true,
  ...extra,
});

const userMessages = (h: ReturnType<typeof harness>) =>
  h.items().filter((item) => item.type === "message" && item.role === "user");

test("compaction reads as compacting while it runs, then one compacted row holding its summary", () => {
  const h = harness();
  h.init();
  h.system("status", { status: "compacting" });
  expect(h.state.agents["root"]?.activity).toBe("compacting");
  h.system("compact_boundary", {
    compact_metadata: { trigger: "auto", pre_tokens: 912_000, post_tokens: 41_000 },
  });
  h.send(summaryFrame());
  const compactions = h.items().filter((item) => item.type === "compaction");
  expect(compactions).toHaveLength(1);
  expect(compactions[0]).toMatchObject({
    tokensBefore: 912_000,
    tokensAfter: 41_000,
    summary: summaryText,
  });
  // The provider's frames stay with the row, the summary's own included.
  expect(compactions[0]?.type === "compaction" && compactions[0].raw?.length).toBe(2);
  expect(userMessages(h)).toEqual([]);
});

test("a summary Claude marks as one folds into a compaction even without its boundary", () => {
  const h = harness();
  h.init();
  h.send(summaryFrame({ isSynthetic: undefined, isCompactSummary: true }));
  expect(h.items().find((item) => item.type === "compaction")).toMatchObject({
    summary: summaryText,
  });
  expect(userMessages(h)).toEqual([]);
});

test("a synthetic note after the compaction's summary or the model's reply stays a message", () => {
  const h = harness();
  h.init();
  h.system("compact_boundary", { compact_metadata: { trigger: "manual", pre_tokens: 10 } });
  h.send({
    type: "assistant",
    message: { id: "reply", content: [{ type: "text", text: "Picking up where I left off." }] },
    parent_tool_use_id: null,
  });
  h.send(summaryFrame({ uuid: "later-note" }));
  expect(h.items().find((item) => item.type === "compaction")).not.toHaveProperty("summary");
  expect(userMessages(h)).toHaveLength(1);
});

test("the person's own message right after a compaction is never taken for its summary", () => {
  const h = harness();
  h.init();
  h.system("compact_boundary", { compact_metadata: { trigger: "manual", pre_tokens: 10 } });
  h.send({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "Now ship it" }] },
    parent_tool_use_id: null,
    uuid: "person",
  });
  expect(h.items().find((item) => item.type === "compaction")).not.toHaveProperty("summary");
  expect(userMessages(h)).toHaveLength(1);
});
