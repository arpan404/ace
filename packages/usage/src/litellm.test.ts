import { expect, test } from "vitest";
import { matchModel, parseLiteLLM } from "./litellm.ts";
import { estimateTokens } from "./pricing.ts";
import { defaultPrices } from "./settings.ts";
import { zeroCounts } from "./counters.ts";

const prices = parseLiteLLM(
  {
    "github_copilot/gpt-6.1-sol": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    "opencode_go/muse-spark-1.3-contributor": {
      input_cost_per_token: 1e-6,
      output_cost_per_token: 2e-6,
    },
    "gemini/gemini-2.5-pro": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    "claude-opus-5-5": {
      input_cost_per_token: 2e-6,
      output_cost_per_token: 10e-6,
      cache_read_input_token_cost: 0.2e-6,
      cache_creation_input_token_cost: 2.5e-6,
      cache_creation_input_token_cost_above_1hr: 4e-6,
      output_cost_per_reasoning_token: 12e-6,
    },
    "openrouter/anthropic/claude-opus-5-5": {
      input_cost_per_token: 3e-6,
      output_cost_per_token: 15e-6,
    },
    future: { unknown: true },
  },
  "2026-11-01",
);
test("cache writes, reads and reasoning are billed once at their distinct rates", () => {
  expect(
    estimateTokens(
      {
        ...zeroCounts,
        input: 1e6,
        cached: 2e5,
        write: 2e5,
        write1h: 1e5,
        output: 1e6,
        reasoning: 5e5,
      },
      "claude-opus-5-5",
      prices,
    ),
  ).toBeCloseTo(12.89);
});
test("exact routes win and CLI routes and explicit aliases match deterministically", () => {
  expect(matchModel("openrouter/anthropic/claude-opus-5-5", prices.models)).toBe(
    "openrouter/anthropic/claude-opus-5-5",
  );
  expect(matchModel("opencode-go/claude-opus-5-5#high", prices.models)).toBe("claude-opus-5-5");
  expect(matchModel("google-gemini-cli/gemini-2.5-pro", prices.models)).toBe(
    "gemini/gemini-2.5-pro",
  );
  expect(matchModel("opencode-go/muse-spark-1.3-contributor", prices.models)).toBe(
    "opencode_go/muse-spark-1.3-contributor",
  );
  expect(matchModel("gemini-pro", prices.models)).toBe("gemini/gemini-2.5-pro");
  expect(matchModel("openrouter/anthropic/claude-opus-5.5", prices.models)).toBe("claude-opus-5-5");
  expect(matchModel("openai-codex/claude-opus-5-5", prices.models)).toBe("claude-opus-5-5");
  expect(matchModel("github-copilot/gpt-6.1-sol", prices.models)).toBe(
    "github_copilot/gpt-6.1-sol",
  );
  expect(matchModel("openrouter/missing", prices.models)).toBeUndefined();
  expect(matchModel("claude-opus-5", prices.models)).toBeUndefined();
});
test("a malformed entry cannot discard valid entries, but an empty price document is rejected", () => {
  expect(prices.models.future).toBeUndefined();
  expect(() => parseLiteLLM({ error: "bad" }, "2026-11-01")).toThrow();
});

test("the previously bundled OpenRouter Sonnet id keeps its upstream API estimate", () => {
  expect(matchModel("openrouter/anthropic/claude-sonnet-4.6", defaultPrices.models)).toBe(
    "claude-sonnet-4-6",
  );
});
