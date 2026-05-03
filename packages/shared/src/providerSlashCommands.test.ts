import { describe, expect, it } from "vitest";

import {
  mergeProviderSlashCommands,
  normalizeProviderSlashCommandName,
  providerPluginSlashCommand,
  providerFallbackSlashCommands,
  providerSkillSlashCommand,
} from "./providerSlashCommands";

describe("providerSlashCommands", () => {
  it("normalizes command names", () => {
    expect(normalizeProviderSlashCommandName("/review")).toBe("review");
    expect(normalizeProviderSlashCommandName("@browser-use")).toBe("browser-use");
    expect(normalizeProviderSlashCommandName("$frontend-design")).toBe("frontend-design");
    expect(normalizeProviderSlashCommandName("  //plan  ")).toBe("plan");
    expect(normalizeProviderSlashCommandName("/bad name")).toBeNull();
  });

  it("creates concrete skill and plugin command invocations", () => {
    expect(providerSkillSlashCommand({ name: "frontend-design" })).toMatchObject({
      name: "frontend-design",
      kind: "skill",
      promptPrefix: "$frontend-design",
    });
    expect(providerPluginSlashCommand({ name: "browser-use" })).toMatchObject({
      name: "browser-use",
      kind: "plugin",
      promptPrefix: "@browser-use",
    });
  });

  it("merges dynamic commands before fallback commands", () => {
    const merged = mergeProviderSlashCommands(
      [
        providerSkillSlashCommand({
          name: "/frontend-design",
          description: "Provider-specific skill",
          promptPrefix: "$frontend-design",
        }),
        { name: "/status", description: "Terminal status" },
      ],
      providerFallbackSlashCommands("codex"),
    );

    expect(merged.find((command) => command.name === "frontend-design")?.description).toBe(
      "Provider-specific skill",
    );
    expect(merged.find((command) => command.name === "frontend-design")?.kind).toBe("skill");
    expect(merged.some((command) => command.name === "status")).toBe(false);
  });

  it("classifies extension commands from provider prompt prefixes", () => {
    expect(
      mergeProviderSlashCommands([
        { name: "plugin-browser", promptPrefix: "@browser-use" },
        { name: "skill-frontend", promptPrefix: "$frontend-design" },
      ]),
    ).toEqual([
      { name: "plugin-browser", kind: "plugin", promptPrefix: "@browser-use" },
      { name: "skill-frontend", kind: "skill", promptPrefix: "$frontend-design" },
    ]);
  });

  it("does not expose generic fallback extension browsers", () => {
    expect(providerFallbackSlashCommands("githubCopilot")).toEqual([]);
    expect(providerFallbackSlashCommands("cursor")).toEqual([]);
  });
});
