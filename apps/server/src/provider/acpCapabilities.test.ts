import { describe, expect, it } from "vitest";

import {
  acpMultiAgentDefinitionPaths,
  acpMultiAgentInvocationPrefixes,
  acpSideConversationCommands,
  acpSideConversationMethods,
  hasAcpMultiAgentCapability,
  hasAcpProviderThreadTargetingCapability,
  hasAcpSideConversationCapability,
  hasAcpSessionCloseCapability,
  hasAcpSessionForkCapability,
  hasAcpSessionResumeCapability,
} from "./acpCapabilities.ts";

describe("acpCapabilities", () => {
  it("detects baseline Agent Client Protocol session fork capability shapes", () => {
    expect(
      hasAcpSessionForkCapability({
        agentCapabilities: {
          sessionCapabilities: {
            fork: true,
          },
        },
      }),
    ).toBe(true);
    expect(
      hasAcpSessionForkCapability({
        agentCapabilities: {
          sessions: {
            fork: "supported",
          },
        },
      }),
    ).toBe(true);
  });

  it("detects newer session.fork capability spellings", () => {
    expect(
      hasAcpSessionForkCapability({
        agentCapabilities: {
          "session.fork": true,
        },
      }),
    ).toBe(true);
    expect(
      hasAcpSessionForkCapability({
        capabilities: {
          session: {
            fork: true,
          },
        },
      }),
    ).toBe(true);
    expect(
      hasAcpSessionForkCapability({
        session: {
          forkSession: "enabled",
        },
      }),
    ).toBe(true);
  });

  it("detects ACP extension capabilities from _meta", () => {
    expect(
      hasAcpSessionForkCapability({
        _meta: {
          capabilities: {
            sessionCapabilities: {
              fork: {},
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      hasAcpSessionForkCapability({
        _meta: {
          "session.fork": true,
        },
      }),
    ).toBe(true);
  });

  it("detects explicit ACP session/fork method lists", () => {
    expect(
      hasAcpSessionForkCapability({
        agentCapabilities: {
          availableMethods: ["session/new", "session/prompt", "session/fork"],
        },
      }),
    ).toBe(true);
    expect(
      hasAcpSessionForkCapability({
        capabilities: {
          available_methods: ["session.new", "session.fork"],
        },
      }),
    ).toBe(true);
    expect(
      hasAcpSessionForkCapability({
        capabilities: {
          methods: [{ method: "session/fork" }, { name: "session.prompt" }],
        },
      }),
    ).toBe(true);
  });

  it("does not treat omitted or disabled fork capabilities as supported", () => {
    expect(hasAcpSessionForkCapability({ agentCapabilities: {} })).toBe(false);
    expect(
      hasAcpSessionForkCapability({
        agentCapabilities: {
          sessionCapabilities: {
            fork: false,
          },
        },
      }),
    ).toBe(false);
  });

  it("detects ACP session resume capability shapes", () => {
    expect(
      hasAcpSessionResumeCapability({
        agentCapabilities: {
          sessionCapabilities: {
            resume: {},
          },
        },
      }),
    ).toBe(true);
    expect(
      hasAcpSessionResumeCapability({
        _meta: {
          capabilities: {
            session: {
              resume: "supported",
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      hasAcpSessionResumeCapability({
        availableMethods: ["session/new", "session.resume"],
      }),
    ).toBe(true);
    expect(
      hasAcpSessionResumeCapability({
        capabilities: {
          availableMethods: [{ method: "session/resume" }],
        },
      }),
    ).toBe(true);
  });

  it("does not treat omitted or disabled resume capabilities as supported", () => {
    expect(hasAcpSessionResumeCapability({ agentCapabilities: {} })).toBe(false);
    expect(
      hasAcpSessionResumeCapability({
        agentCapabilities: {
          sessionCapabilities: {
            resume: false,
          },
        },
      }),
    ).toBe(false);
  });

  it("detects ACP session close capability shapes", () => {
    expect(
      hasAcpSessionCloseCapability({
        agentCapabilities: {
          sessionCapabilities: {
            close: {},
          },
        },
      }),
    ).toBe(true);
    expect(
      hasAcpSessionCloseCapability({
        _meta: {
          capabilities: {
            session: {
              close: "supported",
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      hasAcpSessionCloseCapability({
        availableMethods: ["session/new", "session.close"],
      }),
    ).toBe(true);
    expect(
      hasAcpSessionCloseCapability({
        capabilities: {
          methods: [{ path: "session/close" }],
        },
      }),
    ).toBe(true);
  });

  it("does not treat omitted or disabled close capabilities as supported", () => {
    expect(hasAcpSessionCloseCapability({ agentCapabilities: {} })).toBe(false);
    expect(
      hasAcpSessionCloseCapability({
        agentCapabilities: {
          sessionCapabilities: {
            close: false,
          },
        },
      }),
    ).toBe(false);
  });

  it("detects ACP side conversation capability shapes", () => {
    expect(
      hasAcpSideConversationCapability({
        agentCapabilities: {
          sessionCapabilities: {
            sideChat: { supported: true },
          },
        },
      }),
    ).toBe(true);
    expect(
      hasAcpSideConversationCapability({
        capabilities: {
          session: {
            sideConversation: true,
          },
        },
      }),
    ).toBe(true);
    expect(
      hasAcpSideConversationCapability({
        _meta: {
          capabilities: {
            session: {
              sideThread: "supported",
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      hasAcpSideConversationCapability({
        availableMethods: ["session/new", "conversation/side/thread"],
      }),
    ).toBe(true);
    expect(
      hasAcpSideConversationCapability({
        capabilities: {
          features: [{ id: "side-conversation" }],
        },
      }),
    ).toBe(true);
  });

  it("extracts callable ACP side conversation methods", () => {
    expect(
      acpSideConversationMethods({
        availableMethods: [
          "session/new",
          "conversation/side/thread",
          { method: "session/side/thread" },
          { id: "conversation.side.thread" },
          "conversation/side/thread",
        ],
      }),
    ).toEqual(["conversation/side/thread", "session/side/thread"]);
  });

  it("does not treat omitted or disabled side conversation capabilities as supported", () => {
    expect(hasAcpSideConversationCapability({ agentCapabilities: {} })).toBe(false);
    expect(
      hasAcpSideConversationCapability({
        capabilities: {
          session: {
            sideChat: false,
          },
        },
      }),
    ).toBe(false);
  });

  it("uses provider side conversation aliases only as internal support signals", () => {
    expect(
      acpSideConversationCommands({
        agentCapabilities: {
          sideConversationCommands: ["/btw", "/btw"],
          sessionCapabilities: {
            sideChat: {
              commands: [".side"],
              aliases: ["  /side  "],
            },
          },
        },
        _meta: {
          capabilities: {
            sideThread: {
              commandAliases: [".btw"],
            },
          },
        },
      }),
    ).toEqual([]);
  });

  it("does not extract generic ACP commands as side conversation aliases", () => {
    expect(
      acpSideConversationCommands({
        capabilities: {
          commands: ["/review"],
          sideChat: true,
        },
      }),
    ).toEqual([]);
  });

  it("detects ACP provider thread targeting capability shapes", () => {
    expect(
      hasAcpProviderThreadTargetingCapability({
        agentCapabilities: {
          sessionCapabilities: {
            childSessionTargeting: { enabled: true },
          },
        },
      }),
    ).toBe(true);
    expect(
      hasAcpProviderThreadTargetingCapability({
        capabilities: {
          providerThreadTargeting: true,
        },
      }),
    ).toBe(true);
    expect(
      hasAcpProviderThreadTargetingCapability({
        _meta: {
          capabilities: {
            session: {
              childThreadTargeting: "supported",
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      hasAcpProviderThreadTargetingCapability({
        methods: ["provider/session/target"],
      }),
    ).toBe(true);
    expect(
      hasAcpProviderThreadTargetingCapability({
        _meta: {
          capabilities: {
            supportedFeatures: [{ name: "child-session-targeting" }],
          },
        },
      }),
    ).toBe(true);
  });

  it("does not treat omitted or disabled provider thread targeting as supported", () => {
    expect(hasAcpProviderThreadTargetingCapability({ agentCapabilities: {} })).toBe(false);
    expect(
      hasAcpProviderThreadTargetingCapability({
        capabilities: {
          providerThreadTargeting: false,
        },
      }),
    ).toBe(false);
  });

  it("detects ACP multi-agent capability shapes", () => {
    expect(
      hasAcpMultiAgentCapability({
        agentCapabilities: {
          sessionCapabilities: {
            agentTeams: { enabled: true },
          },
        },
      }),
    ).toBe(true);
    expect(
      hasAcpMultiAgentCapability({
        capabilities: {
          session: {
            subagents: "supported",
          },
        },
      }),
    ).toBe(true);
    expect(
      hasAcpMultiAgentCapability({
        _meta: {
          capabilities: {
            session: {
              handoffs: {},
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      hasAcpMultiAgentCapability({
        availableMethods: ["session/new", "agent/team"],
      }),
    ).toBe(true);
    expect(
      hasAcpMultiAgentCapability({
        capabilities: {
          session: {
            availableFeatures: [{ id: "subagents" }],
          },
        },
      }),
    ).toBe(true);
    expect(
      hasAcpMultiAgentCapability({
        customAgents: [{ id: "explore", name: "Explore" }],
      }),
    ).toBe(true);
    expect(
      hasAcpMultiAgentCapability({
        _meta: {
          capabilities: {
            availableFeatures: [{ id: "assistant-profile" }],
          },
        },
      }),
    ).toBe(true);
  });

  it("does not treat omitted or disabled multi-agent capabilities as supported", () => {
    expect(hasAcpMultiAgentCapability({ agentCapabilities: {} })).toBe(false);
    expect(
      hasAcpMultiAgentCapability({
        capabilities: {
          agents: false,
        },
      }),
    ).toBe(false);
  });

  it("extracts ACP multi-agent invocation prefixes and definition paths", () => {
    const initializeResult = {
      agentProfileInvocationPrefixes: ["/profile"],
      agentProfileDefinitionPaths: [".ace/profiles/*.md"],
      agentCapabilities: {
        subagents: {
          invocationPrefixes: ["@", "@"],
          definitionPaths: [".cursor/agents/*.md"],
          chatModeFilesLocations: [".github/chatmodes/*.md"],
        },
      },
      _meta: {
        capabilities: {
          agentInvocationPrefixes: ["/agent"],
          personaInvocationPrefixes: ["/persona"],
          chatModeInvocationPrefixes: ["/mode"],
          agentDefinitionPaths: ["~/.cursor/agents/*.md"],
          personaDefinitionPaths: [".claude/personas/*.md"],
          chatModeDefinitionPaths: [".gemini/chatmodes/*.md"],
          agentFilesLocations: ["configured chat.agentFilesLocations"],
        },
      },
    };

    expect(acpMultiAgentInvocationPrefixes(initializeResult)).toEqual([
      "/profile",
      "@",
      "/agent",
      "/persona",
      "/mode",
    ]);
    expect(acpMultiAgentDefinitionPaths(initializeResult)).toEqual([
      ".ace/profiles/*.md",
      ".cursor/agents/*.md",
      ".github/chatmodes/*.md",
      "~/.cursor/agents/*.md",
      ".claude/personas/*.md",
      ".gemini/chatmodes/*.md",
      "configured chat.agentFilesLocations",
    ]);
  });

  it("uses top-level ACP side-chat aliases only as internal support signals", () => {
    expect(
      hasAcpSideConversationCapability({
        sideChatAliases: [".side"],
      }),
    ).toBe(true);
    expect(
      acpSideConversationCommands({
        btwCommands: ["/btw"],
        sideChatAliases: [".side", "/side"],
      }),
    ).toEqual([]);
  });
});
