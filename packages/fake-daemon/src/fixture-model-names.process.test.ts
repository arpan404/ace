import { expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { modelDisplayName } from "@ace/models/display-name";
import { settingsFixture, FakeServices } from "@ace/fake-daemon";
import { ClientMessage, ServerMessage, type ModelListResult } from "@ace/protocol";

const names: Record<string, string> = {
  "big-pickle": "Big Pickle",
  "Composer 2.5": "Composer 2.5",
  "composer-2.5": "Composer 2.5",
  "composer-2.5-fast": "Composer 2.5 Fast",
  "composer-2": "Composer 2",
  "claude-fable-5": "Fable 5",
  "claude-fable-5-1": "Fable 5.1",
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
  "claude-opus-4": "Opus 4",
  "claude-opus-4-1": "Opus 4.1",
  "claude-opus-4-5": "Opus 4.5",
  "claude-opus-4-6": "Opus 4.6",
  "claude-opus-4-7": "Opus 4.7",
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-5": "Opus 5",
  "claude-opus-5-5": "Opus 5.5",
  "claude-sonnet-4": "Sonnet 4",
  "claude-sonnet-4-5": "Sonnet 4.5",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-sonnet-5": "Sonnet 5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  condor: "Condor",
  default: "Default",
  inherit: "Inherit",
  sonnet: "Sonnet",
  auto: "Auto",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-3-flash": "Gemini 3 Flash",
  "gemini-3.1-pro": "Gemini 3.1 Pro",
  "gemini-3.5-flash": "Gemini 3.5 Flash",
  "gemini-3.6-flash": "Gemini 3.6 Flash",
  "gemini-3.7-flash": "Gemini 3.7 Flash",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "glm-5.2": "GLM 5.2",
  "glm-5.3": "GLM 5.3",
  "glm-5p3": "GLM 5.3",
  "glm-5p3-flash": "GLM 5.3 Flash",
  "gpt-5": "GPT-5",
  "gpt-5-codex": "GPT-5 Codex",
  "gpt-5-mini": "GPT-5 Mini",
  "gpt-5.1": "GPT-5.1",
  "gpt-5.2": "GPT-5.2",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.4-nano": "GPT-5.4 Nano",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-6": "GPT-6",
  "gpt-6-sol": "GPT-6 Sol",
  "gpt-6.1-sol": "GPT-6.1 Sol",
  "gpt-6.2-sol": "GPT-6.2 Sol",
  "gpt-6-luna": "GPT-6 Luna",
  "grok-4.5": "Grok 4.5",
  "grok-4.6": "Grok 4.6",
  "grok-4.7": "Grok 4.7",
  "grok-4.7-high": "Grok 4.7 High",
  "kimi-k2.7-code": "Kimi K2.7 Code",
  "kimi-k3": "Kimi K3",
  "muse-spark-1.3": "Muse Spark 1.3",
  "muse-spark-1.3-contributor": "Muse Spark 1.3 Contributor",
  "muse-spark-1.2-contributor": "Muse Spark 1.2 Contributor",
  "qwen3-235b-a22b": "Qwen3 235B A22B",
  "qwen2-72b": "Qwen2 72B",
};
function fixtureIds(): string[] {
  const ids = new Set<string>();
  function collect(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    const object = z.record(z.string(), z.unknown()).safeParse(value);
    if (!object.success) return;
    for (const [key, item] of Object.entries(object.data)) {
      if (
        [
          "model",
          "modelId",
          "modelID",
          "currentModelId",
          "resolvedModel",
          "resolvedModelId",
        ].includes(key) &&
        typeof item === "string"
      )
        ids.add(item);
      collect(item);
    }
  }
  const root = resolve(import.meta.dirname, "../../../fixtures");
  for (const path of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (!/\.jsonl?$/.test(path)) continue;
    const text = readFileSync(resolve(root, path), "utf8");
    for (const value of path.endsWith(".jsonl")
      ? text
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [JSON.parse(text)])
      collect(value);
  }
  return [...ids];
}
const ids = [
  ...new Set([...fixtureIds(), ...settingsFixture(1000).models.map((model) => model.id)]),
];
test.each(ids)("fixture route %s has its expected human name", (id) => {
  const native = id.slice(id.indexOf("/") + 1);
  expect(modelDisplayName(id).displayName).toBe(names[native]);
});
test("fake catalog exposes current, legacy, local and paid sources with concrete defaults", () => {
  const models = settingsFixture(1000).models;
  expect(
    models
      .filter((model) => model.isDefault && model.provider === "claude")
      .map((model) => model.id),
  ).toEqual(["claude-opus-5-5", "claude-opus-5-5"]);
  expect(
    models.filter((model) => model.provider === "opencode").map((model) => model.source?.kind),
  ).toEqual(expect.arrayContaining(["local", "subscription", "api_key"]));
  expect(
    models.filter((model) => model.provider === "pi").map((model) => model.source?.label),
  ).toEqual(expect.arrayContaining(["GitHub Copilot", "Anthropic"]));
  expect(models.find((model) => model.id === "gpt-6-sol")).toMatchObject({
    tier: "legacy",
    hidden: false,
  });
  expect(
    models.find((model) => model.id === "opencode-go/muse-spark-1.3-contributor"),
  ).toMatchObject({
    tier: "current",
    isDefault: true,
  });
  expect(
    models.find((model) => model.id === "opencode-go/muse-spark-1.2-contributor"),
  ).toMatchObject({
    tier: "legacy",
    isDefault: false,
    hidden: false,
  });
});

test("fake model responses expose the failing connection and stale provider alongside last-good models", () => {
  const services = new FakeServices({ clock: () => 1000, thread: () => undefined });
  let result: ModelListResult | undefined;
  services.handle(ClientMessage.parse({ type: "models.list", requestId: "catalog" }), (value) => {
    const message = ServerMessage.parse(value);
    if (message.type === "models.result" && "models" in message.result) result = message.result;
  });
  expect(result?.instances.find((instance) => instance.provider === "opencode")).toMatchObject({
    status: "stale",
    sources: expect.arrayContaining([
      expect.objectContaining({
        source: expect.objectContaining({ id: "openrouter" }),
        status: "stale",
        error: expect.objectContaining({ code: "unreachable" }),
      }),
    ]),
  });
  expect(result?.instances.find((instance) => instance.provider === "cursor")).toMatchObject({
    status: "stale",
    errorDetail: { code: "auth_expired" },
  });
  expect(result?.models.some((model) => model.nativeProviderId === "openrouter")).toBe(true);
  expect(result?.models.find((model) => model.nativeProviderId === "opencode")).toMatchObject({
    source: { kind: "api_key", service: "opencode_zen" },
  });
});
