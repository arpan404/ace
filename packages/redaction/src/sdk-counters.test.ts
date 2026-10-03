import { expect, it } from "vitest";
import { createRedactor } from "./index.ts";

it("preserves numeric SDK accounting counters while scrubbing credential-shaped values", () => {
  const scrub = createRedactor({});
  const safe: unknown = JSON.parse(
    scrub(
      JSON.stringify({
        usage: {
          inputTokens: 12,
          outputTokens: 7,
          cacheReadTokens: 2,
          cacheWriteTokens: 3,
          reasoningTokens: 1,
          totalTokens: 19,
        },
        delta: { type: "token-delta", tokens: 4 },
        opaque: {
          inputTokens: "sentinel-secret",
          token: "sentinel-secret",
          apiKey: "sentinel-key",
          password: 123,
          totalTokens: "sentinel-secret",
          tokens: "sentinel-secret",
        },
      }),
    ),
  );
  expect(safe).toEqual({
    usage: {
      inputTokens: 12,
      outputTokens: 7,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      reasoningTokens: 1,
      totalTokens: 19,
    },
    delta: { type: "token-delta", tokens: 4 },
    opaque: {
      inputTokens: "<SECRET>",
      token: "<SECRET>",
      apiKey: "<SECRET>",
      password: "<SECRET>",
      totalTokens: "<SECRET>",
      tokens: "<SECRET>",
    },
  });
});
