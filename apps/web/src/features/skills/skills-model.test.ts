import { expect, test } from "vitest";
import {
  PluginNameInput,
  PluginRepository,
  availabilityText,
  skillCatalog,
  suggestedPluginName,
} from "./skills-model.ts";

const install = (name: string) => ({
  name,
  version: "1.2.0",
  commit: "a".repeat(40),
  hash: "b".repeat(64),
  acceptedAt: 0,
});

test("a component is on only while its plugin is on for at least one provider", () => {
  const catalog = skillCatalog(
    [install("tools")],
    [{ name: "tools", enabled: true, providers: [] }],
    [
      {
        plugin: "tools",
        name: "tdd",
        kind: "skill",
        path: "skills/tdd/SKILL.md",
        description: "Red, green, refactor",
        enabled: true,
        providers: [],
      },
    ],
  );
  expect(catalog.map((skill) => [skill.id, skill.enabled])).toEqual([
    ["tools~skill~tdd", false],
    ["plugin~tools", false],
  ]);
  expect(catalog[1]?.description).toBe("Version 1.2.0 · 1 skill");
});

test("availability reads as the providers by name", () => {
  expect(availabilityText(["claude"])).toBe("Claude Code only");
  expect(availabilityText(["claude", "codex", "opencode"])).toBe("Claude Code, Codex and OpenCode");
  expect(availabilityText([])).toBe("No provider");
  expect(
    availabilityText(["acp", "antigravity", "claude", "codex", "cursor", "opencode", "pi"]),
  ).toBe("Every provider");
});

test("a GitHub owner/name becomes its git URL; URLs and local paths pass through", () => {
  expect(PluginRepository.parse(" getsentry/sentry-mcp ")).toBe(
    "https://github.com/getsentry/sentry-mcp.git",
  );
  expect(PluginRepository.parse("git@github.com:acme/tools.git")).toBe(
    "git@github.com:acme/tools.git",
  );
  expect(PluginRepository.parse("/Users/me/plugins")).toBe("/Users/me/plugins");
  expect(PluginRepository.safeParse("not a repo").success).toBe(false);
});

test("the plugin name is suggested from the repository and must be a marketplace name", () => {
  expect(suggestedPluginName("https://github.com/getsentry/Sentry_MCP.git")).toBe("sentry-mcp");
  expect(PluginNameInput.parse("Sentry")).toBe("sentry");
  expect(PluginNameInput.safeParse("two--dashes").success).toBe(false);
});
