import { expect, test } from "vitest";
import { harness } from "./translator.test-helper.ts";

test("routine Claude control and stream traffic never becomes transcript notices", () => {
  const h = harness();
  h.init();
  h.send({ type: "control_response", response: { subtype: "success", request_id: "init" } });
  h.send({ type: "stream_event", event: { type: "message_start", message: { id: "m" } } });
  h.send({ type: "keep_alive" });
  h.result({ uuid: "r", usage: { input_tokens: 10, output_tokens: 2 } });
  h.result({ uuid: "r" });
  expect(h.items().filter((item) => item.type === "notice")).toEqual([]);
  expect(
    h.diagnostics.some((raw) => "data" in raw && JSON.stringify(raw.data).includes("keep_alive")),
  ).toBe(true);
  expect(h.state.status.state).toBe("done");
});

test("Claude publishes the concrete root model for its transcript and usage", () => {
  const h = harness();
  h.init();
  h.send({
    type: "assistant",
    message: {
      id: "m",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "reply" }],
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  });
  h.result({
    uuid: "r",
    usage: { input_tokens: 10, output_tokens: 2 },
    total_cost_usd: 0.081,
    modelUsage: {
      "claude-sonnet-4-6": {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.081,
        contextWindow: 200000,
      },
    },
  });
  expect(h.state.agents.root?.agent.model).toBe("claude-sonnet-4-6");
  expect(
    h.events.filter((event) => event.type === "usage.updated" && event.usageScope === "agent"),
  ).toMatchObject([
    { model: "claude-sonnet-4-6", inputTokens: 10, outputTokens: 2, contextWindow: 200000 },
  ]);
  expect(
    h.events.filter(
      (event) => event.type === "usage.updated" && event.usageScope === "provider_session",
    ),
  ).toMatchObject([{ costUsd: 0.081 }]);
});
