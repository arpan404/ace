import { ProviderKind } from "@ace/protocol";
import { expect, test } from "vitest";
import { brandArt, brandAtSize, providerIcon } from "./provider-icons.ts";

test("each built-in provider shows its own mark, named as people know the product", async () => {
  for (const provider of ProviderKind.options.filter((kind) => kind !== "acp")) {
    const { brand, label } = providerIcon({ provider });
    expect(brand, provider).toBeDefined();
    if (!brand) continue;
    const art = await brandArt[brand]();
    expect(art.mono.length, provider).toBeGreaterThan(0);
    expect(label).not.toBe("");
  }
  expect(providerIcon({ provider: "claude" }).label).toBe("Claude Code");
});

test("an ACP agent from the registry shows its own mark and registry name", () => {
  expect(providerIcon({ provider: "acp", acpAgentId: "official:gemini" })).toEqual({
    brand: "geminicli",
    label: "Gemini CLI",
  });
  expect(providerIcon({ provider: "acp", acpAgentId: "official:github-copilot-cli" })).toEqual({
    brand: "githubcopilot",
    label: "GitHub Copilot",
  });
});

test("a locally added agent reaches the registry agent it names", () => {
  expect(providerIcon({ provider: "acp", acpAgentId: "local:Gemini CLI" }).brand).toBe("geminicli");
  expect(providerIcon({ provider: "acp", acpAgentId: "claude-code-acp" }).label).toBe(
    "Claude Agent",
  );
});

test("an agent with no brand mark gets the neutral glyph and keeps its own name", () => {
  expect(providerIcon({ provider: "acp", acpAgentId: "local:house-reviewer" })).toEqual({
    brand: undefined,
    label: "house-reviewer",
  });
  expect(providerIcon({ provider: "acp", acpAgentId: "official:factory-droid" })).toEqual({
    brand: undefined,
    label: "Factory Droid",
  });
  expect(providerIcon({ provider: "acp" })).toEqual({ brand: undefined, label: "ACP agent" });
});

const family = (model: string) => providerIcon({ provider: "opencode", model }).brand;

test("a model's family mark wins over the provider's, whatever the id's shape", () => {
  expect(family("anthropic/claude-sonnet-4-5")).toBe("claude");
  expect(family("Opus 4.6")).toBe("claude");
  expect(family("gpt-5.3-codex")).toBe("openai");
  expect(family("o3")).toBe("openai");
  expect(family("google/gemini-2.5-pro")).toBe("gemini");
  expect(family("qwen3-coder")).toBe("qwen");
  expect(family("glm-4.7")).toBe("zai");
  expect(family("devstral-medium")).toBe("mistral");
  expect(providerIcon({ provider: "cursor", model: "composer-2.5" })).toEqual({
    brand: "cursor",
    label: "Cursor Composer",
  });
});

test("a model of an unknown family keeps the provider's mark", () => {
  expect(providerIcon({ provider: "opencode", model: "opencode-go/muse-spark-1.3" })).toEqual({
    brand: "opencode",
    label: "OpenCode",
  });
  expect(providerIcon({ provider: "codex", model: "photon" }).brand).toBe("codex");
});

test("a mark with a cutout gives way to its maker's simpler mark at row sizes", () => {
  expect(brandAtSize("codex", 12)).toBe("openai");
  expect(brandAtSize("codex", 14)).toBe("openai");
  expect(brandAtSize("codex", 16)).toBe("codex");
  expect(brandAtSize("claude", 12)).toBe("claude");
});
