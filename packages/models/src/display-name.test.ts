import { expect, test } from "vitest";
import { modelDisplayName } from "@ace/models/display-name";

test.each([
  ["opencode-go/muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor", "opencode-go"],
  ["claude-opus-5-5", "Claude Opus 5.5", undefined],
  ["gpt-6.1-sol", "GPT-6.1 Sol", undefined],
  ["anthropic/claude-opus-4-8", "Claude Opus 4.8", "anthropic"],
  ["anthropic/claude-3-5-sonnet", "Claude 3.5 Sonnet", "anthropic"],
  ["openai/gpt-4o-mini", "GPT-4o Mini", "openai"],
  ["openai/gpt-oss-120b", "GPT OSS 120B", "openai"],
  ["openai/o3-mini", "o3 Mini", "openai"],
  ["google/gemini-2.5-pro", "Gemini 2.5 Pro", "google"],
  ["deepseek/deepseek-v3", "DeepSeek V3", "deepseek"],
  ["moonshotai/kimi-k2", "Kimi K2", "moonshotai"],
  ["zai/glm-4.7", "GLM 4.7", "zai"],
  ["qwen/qwen3-235b-a22b", "Qwen3 235B A22B", "qwen"],
  ["mistral/codestral-latest", "Codestral Latest", "mistral"],
  ["meta/llama-3-3-70b", "Llama 3.3 70B", "meta"],
  ["router/custom_model", "Custom Model", "router"],
])("%s has a clean name and a separate upstream provider", (id, displayName, upstreamProvider) => {
  expect(modelDisplayName(id)).toEqual({
    displayName,
    ...(upstreamProvider ? { upstreamProvider } : {}),
  });
});

test("the provider's display name takes precedence", () => {
  expect(modelDisplayName("anthropic/claude-opus-4-8", "Opus from my router")).toEqual({
    displayName: "Opus from my router",
    upstreamProvider: "anthropic",
  });
});
