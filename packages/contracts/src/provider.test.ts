import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProviderSendTurnInput, ProviderSessionStartInput } from "./provider";
import {
  ProviderIntegrationCapabilities,
  ProviderSessionConfigOption,
  ProviderSlashCommand,
} from "./orchestration";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);
const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput);
const decodeProviderIntegrationCapabilities = Schema.decodeUnknownSync(
  ProviderIntegrationCapabilities,
);
const decodeProviderSlashCommand = Schema.decodeUnknownSync(ProviderSlashCommand);
const decodeProviderSessionConfigOption = Schema.decodeUnknownSync(ProviderSessionConfigOption);

describe("ProviderSessionStartInput", () => {
  it("accepts codex-compatible payloads", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      cwd: "/tmp/workspace",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: {
          reasoningEffort: "high",
          fastMode: true,
          providerConfig: {
            web_search: true,
            temperature: 0.7,
            profile: "deep-research",
          },
        },
      },
      runtimeMode: "full-access",
    });
    expect(parsed.runtimeMode).toBe("full-access");
    expect(parsed.modelSelection?.provider).toBe("codex");
    expect(parsed.modelSelection?.model).toBe("gpt-5.3-codex");
    if (parsed.modelSelection?.provider !== "codex") {
      throw new Error("Expected codex modelSelection");
    }
    expect(parsed.modelSelection.options?.reasoningEffort).toBe("high");
    expect(parsed.modelSelection.options?.fastMode).toBe(true);
    expect(parsed.modelSelection.options?.providerConfig).toEqual({
      web_search: true,
      temperature: 0.7,
      profile: "deep-research",
    });
  });

  it("rejects payloads without runtime mode", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
      }),
    ).toThrow();
  });

  it("accepts claude runtime knobs", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "claudeAgent",
      cwd: "/tmp/workspace",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: {
          thinking: true,
          effort: "max",
          fastMode: true,
        },
      },
      runtimeMode: "full-access",
    });
    expect(parsed.provider).toBe("claudeAgent");
    expect(parsed.modelSelection?.provider).toBe("claudeAgent");
    expect(parsed.modelSelection?.model).toBe("claude-sonnet-4-6");
    if (parsed.modelSelection?.provider !== "claudeAgent") {
      throw new Error("Expected claude modelSelection");
    }
    expect(parsed.modelSelection.options?.thinking).toBe(true);
    expect(parsed.modelSelection.options?.effort).toBe("max");
    expect(parsed.modelSelection.options?.fastMode).toBe(true);
    expect(parsed.runtimeMode).toBe("full-access");
  });

  it("accepts github copilot reasoning effort", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "githubCopilot",
      cwd: "/tmp/workspace",
      modelSelection: {
        provider: "githubCopilot",
        model: "gpt-5",
        options: {
          reasoningEffort: "medium",
        },
      },
      runtimeMode: "full-access",
    });
    expect(parsed.provider).toBe("githubCopilot");
    expect(parsed.modelSelection?.provider).toBe("githubCopilot");
    if (parsed.modelSelection?.provider !== "githubCopilot") {
      throw new Error("Expected githubCopilot modelSelection");
    }
    expect(parsed.modelSelection.options?.reasoningEffort).toBe("medium");
  });

  it("accepts replay turns for local transcript recovery", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "cursor",
      runtimeMode: "full-access",
      replayTurns: [
        {
          prompt: "Original prompt",
          attachmentNames: ["diagram.png"],
          assistantResponse: "Original answer",
        },
      ],
    });

    expect(parsed.replayTurns).toEqual([
      {
        prompt: "Original prompt",
        attachmentNames: ["diagram.png"],
        assistantResponse: "Original answer",
      },
    ]);
  });

  it("accepts a provider-neutral fork source", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-fork-target",
      provider: "codex",
      runtimeMode: "full-access",
      forkSource: {
        threadId: "thread-fork-source",
        resumeCursor: {
          threadId: "codex-provider-thread",
        },
      },
    });

    expect(parsed.forkSource).toEqual({
      threadId: "thread-fork-source",
      resumeCursor: {
        threadId: "codex-provider-thread",
      },
    });
  });

  it("accepts pi thought-level model options", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-pi-1",
      provider: "pi",
      cwd: "/tmp/workspace",
      modelSelection: {
        provider: "pi",
        model: "openai/gpt-5.4-mini",
        options: {
          thoughtLevel: "high",
        },
      },
      runtimeMode: "full-access",
    });

    expect(parsed.provider).toBe("pi");
    expect(parsed.modelSelection?.provider).toBe("pi");
    if (parsed.modelSelection?.provider !== "pi") {
      throw new Error("Expected pi modelSelection");
    }
    expect(parsed.modelSelection.options?.thoughtLevel).toBe("high");
  });

  it("accepts pi reasoning effort model options", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-pi-2",
      provider: "pi",
      cwd: "/tmp/workspace",
      modelSelection: {
        provider: "pi",
        model: "openai/gpt-5.4-mini",
        options: {
          reasoningEffort: "high",
        },
      },
      runtimeMode: "full-access",
    });

    expect(parsed.provider).toBe("pi");
    expect(parsed.modelSelection?.provider).toBe("pi");
    if (parsed.modelSelection?.provider !== "pi") {
      throw new Error("Expected pi modelSelection");
    }
    expect(parsed.modelSelection.options?.reasoningEffort).toBe("high");
  });
});

describe("ProviderSessionConfigOption", () => {
  it("accepts typed provider session controls", () => {
    expect(
      decodeProviderSessionConfigOption({
        id: "agent_teams",
        name: "Teams",
        type: "boolean",
        currentValue: "on",
        options: [
          { value: "off", name: "Off" },
          { value: "on", name: "On" },
        ],
      }),
    ).toMatchObject({
      id: "agent_teams",
      type: "boolean",
      currentValue: "on",
    });

    expect(
      decodeProviderSessionConfigOption({
        id: "temperature",
        name: "Temperature",
        type: "number",
        currentValue: "0.7",
        options: [],
        minValue: 0,
        maxValue: 1,
        stepValue: 0.1,
      }),
    ).toMatchObject({
      id: "temperature",
      type: "number",
      currentValue: "0.7",
      minValue: 0,
      maxValue: 1,
      stepValue: 0.1,
    });

    expect(
      decodeProviderSessionConfigOption({
        id: "system_prompt",
        name: "System Prompt",
        type: "text",
        currentValue: "",
        options: [],
      }),
    ).toMatchObject({
      id: "system_prompt",
      type: "text",
      currentValue: "",
    });
  });
});

describe("ProviderIntegrationCapabilities", () => {
  it("defaults side conversation mode for older persisted capability payloads", () => {
    const parsed = decodeProviderIntegrationCapabilities({
      sessionModelSwitch: "in-session",
      sessionModelOptionsSwitch: "in-session",
      liveTurnDiffMode: "workspace",
      reviewChangesMode: "git",
      approvalRequestsMode: "native",
      turnSteeringMode: "queued-message",
      transcriptAuthority: "local",
      sessionResumeMode: "local-replay",
    });

    expect(parsed.sideConversationMode).toBe("replay-fork");
    expect(parsed.sideConversationCommands).toEqual([]);
    expect(parsed.providerThreadTargetingMode).toBe("unsupported");
    expect(parsed.goalControlMode).toBe("unsupported");
    expect(parsed.multiAgentMode).toBe("unsupported");
    expect(parsed.multiAgentInvocationPrefixes).toEqual([]);
    expect(parsed.multiAgentDefinitionPaths).toEqual([]);
    expect(parsed.multiAgentManagementCommands).toEqual([]);
    expect(parsed.hookMode).toBe("unsupported");
    expect(parsed.extensionMode).toBe("unsupported");
    expect(parsed.mcpMode).toBe("unsupported");
    expect(parsed.remoteAgentMode).toBe("unsupported");
    expect(parsed.webAccessMode).toBe("unsupported");
    expect(parsed.hostedSessionMode).toBe("unsupported");
  });

  it("accepts provider hook, extension, MCP, remote-agent, web access, and hosted session capability modes", () => {
    const parsed = decodeProviderIntegrationCapabilities({
      sessionModelSwitch: "in-session",
      sessionModelOptionsSwitch: "in-session",
      liveTurnDiffMode: "workspace",
      reviewChangesMode: "git",
      approvalRequestsMode: "native",
      turnSteeringMode: "queued-message",
      transcriptAuthority: "local",
      sessionResumeMode: "local-replay",
      sideConversationMode: "native-side-thread",
      sideConversationCommands: ["/btw", ".side"],
      multiAgentInvocationPrefixes: ["@", "/agent"],
      multiAgentDefinitionPaths: [".github/agents/*.agent.md"],
      multiAgentManagementCommands: ["/agents list"],
      hookMode: "native",
      extensionMode: "local-discovery",
      mcpMode: "native",
      remoteAgentMode: "local-bridge",
      webAccessMode: "agent-command",
      hostedSessionMode: "local-bridge",
    });

    expect(parsed.sideConversationMode).toBe("native-side-thread");
    expect(parsed.sideConversationCommands).toEqual(["/btw", ".side"]);
    expect(parsed.multiAgentInvocationPrefixes).toEqual(["@", "/agent"]);
    expect(parsed.multiAgentDefinitionPaths).toEqual([".github/agents/*.agent.md"]);
    expect(parsed.multiAgentManagementCommands).toEqual(["/agents list"]);
    expect(parsed.hookMode).toBe("native");
    expect(parsed.extensionMode).toBe("local-discovery");
    expect(parsed.mcpMode).toBe("native");
    expect(parsed.remoteAgentMode).toBe("local-bridge");
    expect(parsed.webAccessMode).toBe("agent-command");
    expect(parsed.hostedSessionMode).toBe("local-bridge");
  });
});

describe("ProviderSlashCommand", () => {
  it("accepts provider agent commands", () => {
    const parsed = decodeProviderSlashCommand({
      name: "security-auditor",
      kind: "agent",
      promptPrefix: "@security-auditor",
      description: "Review code for security issues",
      inputHint: "<prompt>",
      metadata: {
        provider: "github-copilot",
        model: "gpt-5",
      },
    });

    expect(parsed.kind).toBe("agent");
    expect(parsed.promptPrefix).toBe("@security-auditor");
    expect(parsed.metadata).toEqual({
      provider: "github-copilot",
      model: "gpt-5",
    });
  });
});

describe("ProviderSendTurnInput", () => {
  it("accepts codex modelSelection", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: {
          reasoningEffort: "xhigh",
          fastMode: true,
        },
      },
    });

    expect(parsed.modelSelection?.provider).toBe("codex");
    expect(parsed.modelSelection?.model).toBe("gpt-5.3-codex");
    if (parsed.modelSelection?.provider !== "codex") {
      throw new Error("Expected codex modelSelection");
    }
    expect(parsed.modelSelection.options?.reasoningEffort).toBe("xhigh");
    expect(parsed.modelSelection.options?.fastMode).toBe(true);
  });

  it("accepts a provider thread override for child conversations", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: " thread-parent ",
      providerThreadId: " provider-child ",
      input: "continue",
    });

    expect(parsed.threadId).toBe("thread-parent");
    expect(parsed.providerThreadId).toBe("provider-child");
  });

  it("accepts claude modelSelection including ultrathink", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: {
          effort: "ultrathink",
          fastMode: true,
        },
      },
    });

    expect(parsed.modelSelection?.provider).toBe("claudeAgent");
    if (parsed.modelSelection?.provider !== "claudeAgent") {
      throw new Error("Expected claude modelSelection");
    }
    expect(parsed.modelSelection.options?.effort).toBe("ultrathink");
    expect(parsed.modelSelection.options?.fastMode).toBe(true);
  });

  it("accepts github copilot modelSelection", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      modelSelection: {
        provider: "githubCopilot",
        model: "gpt-5",
        options: {
          reasoningEffort: "high",
        },
      },
    });

    expect(parsed.modelSelection?.provider).toBe("githubCopilot");
    if (parsed.modelSelection?.provider !== "githubCopilot") {
      throw new Error("Expected githubCopilot modelSelection");
    }
    expect(parsed.modelSelection.options?.reasoningEffort).toBe("high");
  });

  it("accepts pi modelSelection", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-pi-2",
      modelSelection: {
        provider: "pi",
        model: "openai/gpt-5.4-mini",
        options: {
          thoughtLevel: "minimal",
        },
      },
    });

    expect(parsed.modelSelection?.provider).toBe("pi");
    if (parsed.modelSelection?.provider !== "pi") {
      throw new Error("Expected pi modelSelection");
    }
    expect(parsed.modelSelection.options?.thoughtLevel).toBe("minimal");
  });

  it("accepts pi modelSelection with reasoning effort", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-pi-3",
      modelSelection: {
        provider: "pi",
        model: "openai/gpt-5.4-mini",
        options: {
          reasoningEffort: "xhigh",
        },
      },
    });

    expect(parsed.modelSelection?.provider).toBe("pi");
    if (parsed.modelSelection?.provider !== "pi") {
      throw new Error("Expected pi modelSelection");
    }
    expect(parsed.modelSelection.options?.reasoningEffort).toBe("xhigh");
  });
});
