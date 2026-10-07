import { expect, test } from "vitest";
import { modelDisplayName } from "@ace/models/display-name";

test.each([
  ["opencode-go/muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor", "opencode-go"],
  ["claude-opus-5-5", "Opus 5.5", undefined],
  ["gpt-6.1-sol", "GPT-6.1 Sol", undefined],
  ["anthropic/claude-opus-4-8", "Opus 4.8", "anthropic"],
  ["anthropic/claude-3-5-sonnet", "Sonnet 3.5", "anthropic"],
  ["openai/gpt-4o-mini", "GPT-4o Mini", "openai"],
  ["openai/gpt-oss-120b", "GPT OSS 120B", "openai"],
  ["openai/o3-mini", "o3 Mini", "openai"],
  ["google/gemini-2.5-pro", "Gemini 2.5 Pro", "google"],
  ["deepseek/deepseek-v3", "DeepSeek V3", "deepseek"],
  ["moonshotai/kimi-k2", "Kimi K2", "moonshotai"],
  ["zai/glm-4.7", "GLM 4.7", "zai"],
  ["qwen/qwen3-235b-a22b", "Qwen3 235B A22B", "qwen"],
  ["mistral/codestral-latest", "Codestral", "mistral"],
  ["meta/llama-3-3-70b", "Llama 3.3 70B", "meta"],
  ["router/custom_model", "Custom Model", "router"],
])("%s has a clean name and a separate upstream provider", (id, displayName, upstreamProvider) => {
  expect(modelDisplayName(id)).toMatchObject({
    displayName,
    ...(upstreamProvider ? { upstreamProvider } : {}),
  });
});

test("the provider's display name takes precedence", () => {
  expect(modelDisplayName("anthropic/claude-opus-4-8", "Opus from my router")).toMatchObject({
    displayName: "Opus from my router",
    upstreamProvider: "anthropic",
  });
});

test.each([
  ["claude-haiku-4-5-20251001", "Haiku 4.5", "20251001"],
  ["claude-sonnet-4-20250514", "Sonnet 4", "20250514"],
  ["gpt-6-latest", "GPT-6", "latest"],
  ["gpt-6.1-sol-preview-abc123", "GPT-6.1 Sol", "preview-abc123"],
  ["gpt-6-2026-10-01", "GPT-6", "2026-10-01"],
  ["claude-haiku-4-5-20251001-latest", "Haiku 4.5", "20251001 · latest"],
  ["openrouter/anthropic/claude-opus-5-5", "Opus 5.5", undefined],
])("%s puts the snapshot in detail", (id, displayName, detail) => {
  expect(modelDisplayName(id).displayName).toBe(displayName);
  expect(modelDisplayName(id).detail).toBe(detail);
});
test("a snapshot cannot turn Haiku's version into 25", () => {
  expect(modelDisplayName("claude-haiku-4-5-20251001", "Haiku 25.1001")).toMatchObject({
    displayName: "Haiku 4.5",
    version: "4.5",
    family: "claude-haiku",
    detail: "20251001",
  });
});
