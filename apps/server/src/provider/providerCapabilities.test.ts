import { describe, expect, it } from "vitest";

import {
  defaultProviderIntegrationCapabilities,
  resolveProviderIntegrationCapabilities,
} from "./providerCapabilities.ts";

describe("providerCapabilities", () => {
  it("uses Pi defaults that match the native RPC adapter", () => {
    expect(defaultProviderIntegrationCapabilities("pi")).toMatchObject({
      sessionModelSwitch: "in-session",
      sessionModelOptionsSwitch: "in-session",
      approvalRequestsMode: "none",
      turnSteeringMode: "native",
      transcriptAuthority: "local",
      historyAuthority: "local-server-session",
      sessionResumeMode: "local-replay",
      sessionForkMode: "local-replay",
    });
  });

  it("marks providers with native fork support", () => {
    expect(defaultProviderIntegrationCapabilities("codex").sessionForkMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("claudeAgent").sessionForkMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("opencode").sessionForkMode).toBe("local-replay");
    expect(defaultProviderIntegrationCapabilities("cursor").sessionForkMode).toBe("local-replay");
    expect(defaultProviderIntegrationCapabilities("githubCopilot").sessionForkMode).toBe(
      "local-replay",
    );
  });

  it("marks providers with native resume support", () => {
    expect(defaultProviderIntegrationCapabilities("codex").sessionResumeMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("claudeAgent").sessionResumeMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("githubCopilot").sessionResumeMode).toBe(
      "native",
    );
    expect(defaultProviderIntegrationCapabilities("cursor").sessionResumeMode).toBe("local-replay");
    expect(defaultProviderIntegrationCapabilities("opencode").sessionResumeMode).toBe(
      "local-replay",
    );
  });

  it("declares side conversation support for every provider", () => {
    expect(defaultProviderIntegrationCapabilities("codex").sideConversationMode).toBe(
      "native-fork",
    );
    expect(defaultProviderIntegrationCapabilities("codex").sideConversationCommands).toEqual([]);
    expect(defaultProviderIntegrationCapabilities("claudeAgent").sideConversationMode).toBe(
      "native-fork",
    );
    expect(defaultProviderIntegrationCapabilities("claudeAgent").sideConversationCommands).toEqual(
      [],
    );
    expect(defaultProviderIntegrationCapabilities("cursor").sideConversationMode).toBe(
      "replay-fork",
    );
    expect(defaultProviderIntegrationCapabilities("cursor").sideConversationCommands).toEqual([]);
    expect(defaultProviderIntegrationCapabilities("opencode").sideConversationMode).toBe(
      "replay-fork",
    );
    expect(defaultProviderIntegrationCapabilities("opencode").sideConversationCommands).toEqual([]);
    expect(defaultProviderIntegrationCapabilities("githubCopilot").sideConversationMode).toBe(
      "replay-fork",
    );
    expect(
      defaultProviderIntegrationCapabilities("githubCopilot").sideConversationCommands,
    ).toEqual([]);
    expect(defaultProviderIntegrationCapabilities("gemini").sideConversationMode).toBe(
      "replay-fork",
    );
    expect(defaultProviderIntegrationCapabilities("gemini").sideConversationCommands).toEqual([]);
    expect(defaultProviderIntegrationCapabilities("pi").sideConversationMode).toBe("replay-fork");
    expect(defaultProviderIntegrationCapabilities("pi").sideConversationCommands).toEqual([]);
  });

  it("declares provider child-thread targeting only for adapters that implement it", () => {
    expect(defaultProviderIntegrationCapabilities("codex").providerThreadTargetingMode).toBe(
      "native",
    );
    expect(defaultProviderIntegrationCapabilities("opencode").providerThreadTargetingMode).toBe(
      "native",
    );
    expect(defaultProviderIntegrationCapabilities("claudeAgent").providerThreadTargetingMode).toBe(
      "unsupported",
    );
    expect(defaultProviderIntegrationCapabilities("cursor").providerThreadTargetingMode).toBe(
      "unsupported",
    );
    expect(
      defaultProviderIntegrationCapabilities("githubCopilot").providerThreadTargetingMode,
    ).toBe("unsupported");
    expect(defaultProviderIntegrationCapabilities("gemini").providerThreadTargetingMode).toBe(
      "unsupported",
    );
    expect(defaultProviderIntegrationCapabilities("pi").providerThreadTargetingMode).toBe(
      "unsupported",
    );
  });

  it("declares native provider goal controls only for adapters that implement them", () => {
    expect(defaultProviderIntegrationCapabilities("codex").goalControlMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("claudeAgent").goalControlMode).toBe(
      "unsupported",
    );
    expect(defaultProviderIntegrationCapabilities("cursor").goalControlMode).toBe("unsupported");
    expect(defaultProviderIntegrationCapabilities("githubCopilot").goalControlMode).toBe(
      "unsupported",
    );
    expect(defaultProviderIntegrationCapabilities("gemini").goalControlMode).toBe("unsupported");
    expect(defaultProviderIntegrationCapabilities("opencode").goalControlMode).toBe("unsupported");
    expect(defaultProviderIntegrationCapabilities("pi").goalControlMode).toBe("unsupported");
  });

  it("declares provider multi-agent support without inferring from UI commands", () => {
    expect(defaultProviderIntegrationCapabilities("codex").multiAgentMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("codex").multiAgentInvocationPrefixes).toEqual([
      "@",
    ]);
    expect(defaultProviderIntegrationCapabilities("codex").multiAgentDefinitionPaths).toEqual([
      ".codex/agents",
      "~/.codex/agents",
    ]);
    expect(defaultProviderIntegrationCapabilities("claudeAgent").multiAgentMode).toBe("native");
    expect(
      defaultProviderIntegrationCapabilities("claudeAgent").multiAgentInvocationPrefixes,
    ).toEqual(["@", "@agent-"]);
    expect(defaultProviderIntegrationCapabilities("claudeAgent").multiAgentDefinitionPaths).toEqual(
      [".claude/agents", "~/.claude/agents"],
    );
    expect(defaultProviderIntegrationCapabilities("gemini").multiAgentMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("gemini").multiAgentInvocationPrefixes).toEqual([
      "@",
    ]);
    expect(defaultProviderIntegrationCapabilities("gemini").multiAgentDefinitionPaths).toEqual([
      ".gemini/agents/*.md",
      "~/.gemini/agents/*.md",
      "built-in: codebase_investigator",
      "built-in: cli_help",
      "built-in: generalist",
      "built-in: browser_agent",
    ]);
    expect(defaultProviderIntegrationCapabilities("githubCopilot").multiAgentMode).toBe("native");
    expect(
      defaultProviderIntegrationCapabilities("githubCopilot").multiAgentInvocationPrefixes,
    ).toEqual(["@", "/fleet"]);
    expect(
      defaultProviderIntegrationCapabilities("githubCopilot").multiAgentDefinitionPaths,
    ).toEqual([
      ".github/agents/*.agent.md",
      ".github/agents/*.md",
      ".github/chatmodes/*.chatmode.md",
      ".github-private/agents/*.agent.md",
      ".github-private/agents/*.md",
      ".claude/agents",
      "~/.copilot/agents/*.agent.md",
      "~/.copilot/agents/*.md",
      "~/.copilot/chatmodes/*.chatmode.md",
      "~/.copilot/.github-private/agents/*.agent.md",
      "~/.copilot/.github-private/agents/*.md",
      "~/.github-copilot/agents/*.agent.md",
      "~/.github-copilot/agents/*.md",
      "~/.github-copilot/chatmodes/*.chatmode.md",
      "~/.github-copilot/.github-private/agents/*.agent.md",
      "~/.github-copilot/.github-private/agents/*.md",
      "configured chat.agentFilesLocations",
    ]);
    expect(defaultProviderIntegrationCapabilities("opencode").multiAgentMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("opencode").multiAgentInvocationPrefixes).toEqual(
      ["@"],
    );
    expect(defaultProviderIntegrationCapabilities("opencode").multiAgentDefinitionPaths).toEqual([
      "opencode.json agent",
      "~/.config/opencode/opencode.json agent",
      ".opencode/agent/*.md",
      ".opencode/agents/*.md",
      "~/.config/opencode/agent/*.md",
      "~/.config/opencode/agents/*.md",
      "built-in: general",
      "built-in: explore",
      "built-in: scout",
    ]);
    expect(defaultProviderIntegrationCapabilities("cursor").multiAgentMode).toBe("agent-command");
    expect(defaultProviderIntegrationCapabilities("cursor").multiAgentInvocationPrefixes).toEqual([
      "/",
    ]);
    expect(defaultProviderIntegrationCapabilities("cursor").multiAgentDefinitionPaths).toEqual([
      ".cursor/agents",
      ".cursor/agents/*.md",
      ".claude/agents",
      ".codex/agents",
      "~/.cursor/agents",
      "~/.cursor/agents/*.md",
      "~/.claude/agents",
      "~/.codex/agents",
      "built-in: explore",
      "built-in: bash",
      "built-in: browser",
    ]);
    expect(defaultProviderIntegrationCapabilities("pi").multiAgentMode).toBe("agent-command");
    expect(defaultProviderIntegrationCapabilities("pi").multiAgentInvocationPrefixes).toEqual([
      "@",
    ]);
    expect(defaultProviderIntegrationCapabilities("pi").multiAgentDefinitionPaths).toEqual([
      ".pi/agents",
      ".agents",
      "~/.pi/agent/agents",
      "~/.pi/agent/extensions/subagent/agents",
    ]);
  });

  it("declares provider hook support from documented native provider features", () => {
    expect(defaultProviderIntegrationCapabilities("codex").hookMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("claudeAgent").hookMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("gemini").hookMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("githubCopilot").hookMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("opencode").hookMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("cursor").hookMode).toBe("unsupported");
    expect(defaultProviderIntegrationCapabilities("pi").hookMode).toBe("unsupported");
  });

  it("declares provider customization and extension support", () => {
    expect(defaultProviderIntegrationCapabilities("codex").extensionMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("claudeAgent").extensionMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("gemini").extensionMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("githubCopilot").extensionMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("opencode").extensionMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("pi").extensionMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("cursor").extensionMode).toBe("local-discovery");
  });

  it("declares provider MCP support for adapters with MCP config/status handling", () => {
    expect(defaultProviderIntegrationCapabilities("codex").mcpMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("claudeAgent").mcpMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("gemini").mcpMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("githubCopilot").mcpMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("opencode").mcpMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("cursor").mcpMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("pi").mcpMode).toBe("unsupported");
  });

  it("declares hosted and remote agent support separately from local subagents", () => {
    expect(defaultProviderIntegrationCapabilities("codex").remoteAgentMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("gemini").remoteAgentMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("githubCopilot").remoteAgentMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("claudeAgent").remoteAgentMode).toBe(
      "unsupported",
    );
    expect(defaultProviderIntegrationCapabilities("opencode").remoteAgentMode).toBe("unsupported");
    expect(defaultProviderIntegrationCapabilities("cursor").remoteAgentMode).toBe("unsupported");
    expect(defaultProviderIntegrationCapabilities("pi").remoteAgentMode).toBe("unsupported");
  });

  it("declares provider web access support by first-party surface", () => {
    expect(defaultProviderIntegrationCapabilities("codex").webAccessMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("claudeAgent").webAccessMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("gemini").webAccessMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("cursor").webAccessMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("githubCopilot").webAccessMode).toBe(
      "agent-command",
    );
    expect(defaultProviderIntegrationCapabilities("opencode").webAccessMode).toBe("mcp-or-shell");
    expect(defaultProviderIntegrationCapabilities("pi").webAccessMode).toBe("unsupported");
  });

  it("declares hosted and background session support separately from remote agents", () => {
    expect(defaultProviderIntegrationCapabilities("codex").hostedSessionMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("claudeAgent").hostedSessionMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("cursor").hostedSessionMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("githubCopilot").hostedSessionMode).toBe(
      "native",
    );
    expect(defaultProviderIntegrationCapabilities("gemini").hostedSessionMode).toBe("unsupported");
    expect(defaultProviderIntegrationCapabilities("opencode").hostedSessionMode).toBe(
      "unsupported",
    );
    expect(defaultProviderIntegrationCapabilities("pi").hostedSessionMode).toBe("unsupported");
  });

  it("allows adapters to override multi-agent capability mode", () => {
    expect(
      resolveProviderIntegrationCapabilities("cursor", {
        sessionModelSwitch: "restart-session",
        multiAgentMode: "native",
      }),
    ).toMatchObject({
      multiAgentMode: "native",
    });
  });

  it("preserves Pi defaults when adapter capabilities do not override them", () => {
    expect(
      resolveProviderIntegrationCapabilities("pi", { sessionModelSwitch: "in-session" }),
    ).toMatchObject({
      approvalRequestsMode: "none",
      turnSteeringMode: "native",
      sideConversationMode: "replay-fork",
      providerThreadTargetingMode: "unsupported",
      goalControlMode: "unsupported",
      multiAgentMode: "agent-command",
      hookMode: "unsupported",
      extensionMode: "native",
      mcpMode: "unsupported",
      remoteAgentMode: "unsupported",
      webAccessMode: "unsupported",
      hostedSessionMode: "unsupported",
    });
  });

  it("filters provider side conversation aliases out of user-facing capabilities", () => {
    expect(
      resolveProviderIntegrationCapabilities("codex", { sessionModelSwitch: "in-session" }),
    ).toMatchObject({
      sideConversationCommands: [],
    });
    expect(
      resolveProviderIntegrationCapabilities("codex", {
        sessionModelSwitch: "in-session",
        sideConversationCommands: [" /side ", ".side", "/btw", ".side", "  "],
      }),
    ).toMatchObject({
      sideConversationCommands: [],
    });
  });

  it("preserves default multi-agent metadata unless an adapter advertises it", () => {
    expect(
      resolveProviderIntegrationCapabilities("gemini", { sessionModelSwitch: "in-session" }),
    ).toMatchObject({
      multiAgentInvocationPrefixes: ["@"],
      multiAgentDefinitionPaths: [
        ".gemini/agents/*.md",
        "~/.gemini/agents/*.md",
        "built-in: codebase_investigator",
        "built-in: cli_help",
        "built-in: generalist",
        "built-in: browser_agent",
      ],
    });
    expect(
      resolveProviderIntegrationCapabilities("gemini", {
        sessionModelSwitch: "in-session",
        multiAgentInvocationPrefixes: [" /agent ", "/AGENT", "  ", "@"],
        multiAgentDefinitionPaths: [
          " custom/agents/*.md ",
          "custom/agents/*.md",
          ".gemini/agents/*.md",
        ],
      }),
    ).toMatchObject({
      multiAgentInvocationPrefixes: ["/agent", "@"],
      multiAgentDefinitionPaths: ["custom/agents/*.md", ".gemini/agents/*.md"],
    });
  });
});
