import { describe, expect, it } from "vitest";

import {
  isAceSideConversationCommand,
  isProviderSideConversationAlias,
  mergeProviderSlashCommands,
  normalizeProviderSlashCommandName,
  providerAgentSlashCommand,
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

  it("reserves provider-native side-chat aliases behind the Ace-native /side command", () => {
    expect(isAceSideConversationCommand("/side")).toBe(true);
    expect(isAceSideConversationCommand(" /SIDE ")).toBe(true);
    expect(isAceSideConversationCommand(".side")).toBe(false);
    expect(isAceSideConversationCommand("/btw")).toBe(false);
    expect(isProviderSideConversationAlias("/side")).toBe(true);
    expect(isProviderSideConversationAlias(".side")).toBe(true);
    expect(isProviderSideConversationAlias("btw")).toBe(true);
    expect(isProviderSideConversationAlias("/ask")).toBe(false);
    expect(isProviderSideConversationAlias("/review")).toBe(false);
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

  it("creates concrete agent command invocations", () => {
    expect(providerAgentSlashCommand({ name: "security-auditor" })).toMatchObject({
      name: "security-auditor",
      kind: "agent",
      promptPrefix: "@security-auditor",
    });
  });

  it("merges dynamic commands without static provider CLI fallbacks", () => {
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
        {
          name: "security-auditor",
          kind: "agent",
          promptPrefix: "@security-auditor",
          metadata: { model: "sonnet" },
        },
      ]),
    ).toEqual([
      { name: "plugin-browser", kind: "plugin", promptPrefix: "@browser-use" },
      { name: "skill-frontend", kind: "skill", promptPrefix: "$frontend-design" },
      {
        name: "security-auditor",
        kind: "agent",
        promptPrefix: "@security-auditor",
        metadata: { model: "sonnet" },
      },
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

  it("does not expose static provider CLI fallback commands", () => {
    expect(providerFallbackSlashCommands("codex")).toEqual([]);
    expect(providerFallbackSlashCommands("claudeAgent")).toEqual([]);
    expect(providerFallbackSlashCommands("githubCopilot")).toEqual([]);
    expect(providerFallbackSlashCommands("cursor")).toEqual([]);
    expect(providerFallbackSlashCommands("pi")).toEqual([]);
    expect(providerFallbackSlashCommands("gemini")).toEqual([]);
    expect(providerFallbackSlashCommands("opencode")).toEqual([]);
  });

  it("drops provider-reported side-chat aliases without hiding normal ask agents", () => {
    expect(
      mergeProviderSlashCommands([
        {
          name: "side",
          kind: "provider",
          description: "Provider native side conversation",
          promptPrefix: "/side",
        },
        {
          name: ".side",
          kind: "provider",
          description: "Provider dot-command side conversation",
          promptPrefix: ".side",
        },
        {
          name: "btw",
          kind: "provider",
          description: "Provider side note",
          promptPrefix: "/btw",
        },
        {
          name: "ask",
          kind: "agent",
          description: "Provider side agent",
          promptPrefix: "@ask",
        },
        {
          name: "review",
          kind: "agent",
          description: "Review with a provider agent",
          promptPrefix: "@review",
        },
      ]),
    ).toEqual([
      {
        name: "ask",
        kind: "agent",
        description: "Provider side agent",
        promptPrefix: "@ask",
      },
      {
        name: "review",
        kind: "agent",
        description: "Review with a provider agent",
        promptPrefix: "@review",
      },
    ]);
  });
});
