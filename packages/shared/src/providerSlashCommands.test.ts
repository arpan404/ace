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
    expect(merged.find((command) => command.name === "status")?.description).toBe(
      "Terminal status",
    );
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

  it("drops redundant primary plugin skills while keeping distinct plugin skills", () => {
    expect(
      mergeProviderSlashCommands([
        providerPluginSlashCommand({ name: "spreadsheets" }),
        providerSkillSlashCommand({ name: "spreadsheets:Spreadsheets" }),
        providerPluginSlashCommand({ name: "browser-use" }),
        providerSkillSlashCommand({ name: "browser-use:browser" }),
        providerSkillSlashCommand({ name: "browser-use:inspect-page" }),
      ]),
    ).toEqual([
      { name: "spreadsheets", kind: "plugin", promptPrefix: "@spreadsheets" },
      { name: "browser-use", kind: "plugin", promptPrefix: "@browser-use" },
      {
        name: "browser-use:inspect-page",
        kind: "skill",
        promptPrefix: "$browser-use:inspect-page",
      },
    ]);
  });

  it("drops redundant provider-reported plugin skills after discovered commands are merged", () => {
    expect(
      mergeProviderSlashCommands(
        [providerPluginSlashCommand({ name: "presentations" })],
        [providerSkillSlashCommand({ name: "presentations:Presentations" })],
      ),
    ).toEqual([{ name: "presentations", kind: "plugin", promptPrefix: "@presentations" }]);
  });

  it("returns provider fallback commands for providers that define them", () => {
    expect(
      providerFallbackSlashCommands("githubCopilot").some((command) => command.name === "model"),
    ).toBe(true);
    expect(
      providerFallbackSlashCommands("cursor").some((command) => command.name === "model"),
    ).toBe(true);
  });
});
