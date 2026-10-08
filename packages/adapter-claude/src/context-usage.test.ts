import { expect, test } from "vitest";
import { harness } from "./translator.test-helper.ts";
const assistant = (id: string, input: number) => ({
  type: "assistant",
  message: {
    id,
    model: "claude-model",
    content: [{ type: "text", text: "reply" }],
    usage: {
      input_tokens: input,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 100,
      output_tokens: 20,
    },
  },
});
test("Claude occupancy includes both cache buckets and output without accumulating messages", () => {
  const h = harness();
  h.init();
  h.send(assistant("first", 80));
  h.send(assistant("next", 10));
  expect(
    h.events.filter((event) => event.type === "context.sampled").map((event) => event.usedTokens),
  ).toEqual([1000, 930]);
  h.system("compact_boundary");
  expect(h.items().some((item) => item.type === "compaction")).toBe(true);
});
test("Claude unknown usage fields remain unknown occupancy", () => {
  const h = harness();
  h.init();
  h.send({
    type: "assistant",
    message: {
      id: "message",
      content: [{ type: "text", text: "reply" }],
      usage: { future_usage: true },
    },
  });
  expect(h.events.some((event) => event.type === "context.sampled")).toBe(false);
});

test("Claude result reasoning remains a subset of output and repeated results are counted once", () => {
  const h = harness();
  h.init();
  const usage = {
    uuid: "result-1",
    usage: {
      input_tokens: 10,
      output_tokens: 30,
      output_tokens_details: { thinking_tokens: 20 },
      cache_read_input_tokens: 100,
    },
  };
  h.result(usage);
  h.result(usage);
  expect(
    h.events.filter((event) => event.type === "usage.updated" && event.usageScope === "agent"),
  ).toMatchObject([
    { inputTokens: 110, outputTokens: 30, reasoningTokens: 20, counterMode: "incremental" },
  ]);
});
