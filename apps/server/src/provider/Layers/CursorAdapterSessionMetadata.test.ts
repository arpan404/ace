import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  EMPTY_CURSOR_SESSION_METADATA,
  buildCursorSessionMetadata,
  cursorSessionMetadataSnapshot,
  findCursorConfigOption,
  parseCursorAvailableCommands,
  parseCursorConfigOptions,
  parseCursorInitializeState,
  parseCursorMcpServers,
  parseCursorSessionModeState,
  parseCursorSessionModelState,
} from "./CursorAdapterSessionMetadata.ts";

describe("CursorAdapterSessionMetadata", () => {
  it("parses initialize state and filters invalid auth methods", () => {
    const parsed = parseCursorInitializeState({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        resumeSession: false,
        closeSession: false,
        forkSession: false,
        multiAgent: false,
        multiAgentInvocationPrefixes: [],
        multiAgentDefinitionPaths: [],
        sideConversationCommands: [],
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
      },
      authMethods: [{ id: "cursor_login", name: "Cursor Login" }, { id: "   " }, null],
    });

    assert.deepEqual(parsed, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        resumeSession: false,
        closeSession: false,
        forkSession: false,
        multiAgent: false,
        multiAgentInvocationPrefixes: [],
        multiAgentDefinitionPaths: [],
        sideConversationCommands: [],
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
      },
      authMethods: [{ id: "cursor_login", name: "Cursor Login" }],
    });
  });

  it("recognizes alternate ACP session resume capability shapes", () => {
    for (const initializeResult of [
      { agentCapabilities: { resumeSession: true } },
      { agentCapabilities: { sessionCapabilities: { resume: true } } },
      { agentCapabilities: { "session.resume": true } },
      { sessionCapabilities: { resumeSession: true } },
      { session: { resume: true } },
      { capabilities: { sessionResume: "enabled" } },
      { capabilities: { session: { resume: true } } },
      { availableMethods: ["session/resume"] },
    ]) {
      assert.equal(
        parseCursorInitializeState(initializeResult).agentCapabilities.resumeSession,
        true,
      );
    }
  });

  it("recognizes alternate ACP session close capability shapes", () => {
    for (const initializeResult of [
      { agentCapabilities: { closeSession: true } },
      { agentCapabilities: { sessionCapabilities: { close: true } } },
      { agentCapabilities: { "session.close": true } },
      { sessionCapabilities: { closeSession: true } },
      { session: { close: true } },
      { capabilities: { sessionClose: "enabled" } },
      { capabilities: { session: { close: true } } },
      { availableMethods: ["session/close"] },
    ]) {
      assert.equal(
        parseCursorInitializeState(initializeResult).agentCapabilities.closeSession,
        true,
      );
    }
  });

  it("recognizes alternate ACP session fork capability shapes", () => {
    for (const initializeResult of [
      { agentCapabilities: { forkSession: true } },
      { agentCapabilities: { sessionCapabilities: { fork: true } } },
      { agentCapabilities: { sessions: { fork: "supported" } } },
      { agentCapabilities: { "session.fork": true } },
      { sessionCapabilities: { forkSession: true } },
      { session: { fork: true } },
      { capabilities: { sessionFork: "enabled" } },
      { capabilities: { session: { fork: true } } },
    ]) {
      assert.equal(
        parseCursorInitializeState(initializeResult).agentCapabilities.forkSession,
        true,
      );
    }
  });

  it("recognizes ACP multi-agent capability shapes", () => {
    for (const initializeResult of [
      { agentCapabilities: { subagents: true } },
      { agentCapabilities: { sessionCapabilities: { agentTeams: { enabled: true } } } },
      { capabilities: { session: { availableFeatures: [{ id: "subagents" }] } } },
      { availableMethods: ["agent/team"] },
    ]) {
      assert.equal(parseCursorInitializeState(initializeResult).agentCapabilities.multiAgent, true);
    }
  });

  it("preserves ACP side conversation command aliases in capability snapshots", () => {
    const initialize = parseCursorInitializeState({
      agentCapabilities: {
        sessionCapabilities: {
          sideChat: {
            commands: ["/btw", ".side", "/btw"],
          },
        },
      },
      _meta: {
        capabilities: {
          sideConversationAliases: ["/side"],
        },
      },
    });
    assert.deepEqual(initialize.agentCapabilities.sideConversationCommands, [
      "/btw",
      ".side",
      "/side",
    ]);

    const metadata = buildCursorSessionMetadata({
      previous: EMPTY_CURSOR_SESSION_METADATA,
      initialize,
      configOptions: [],
    });

    assert.deepEqual(cursorSessionMetadataSnapshot(metadata).capabilities, {
      sessionForkMode: "local-replay",
      sessionResumeMode: "local-replay",
      sideConversationMode: "replay-fork",
      sideConversationCommands: ["/btw", ".side", "/side"],
    });
  });

  it("parses mode and model state only when meaningful values exist", () => {
    assert.equal(parseCursorSessionModeState(undefined), undefined);
    assert.equal(parseCursorSessionModelState(undefined), undefined);

    assert.deepEqual(
      parseCursorSessionModeState({
        currentModeId: "plan",
        availableModes: [{ id: "agent", name: "Agent" }, { id: "plan" }, { bad: true }],
      }),
      {
        currentModeId: "plan",
        availableModes: [{ id: "agent", name: "Agent" }, { id: "plan" }],
      },
    );

    assert.deepEqual(
      parseCursorSessionModeState({
        current_mode_id: "plan",
        modes: [
          { id: "agent", label: "Agent" },
          { value: "plan", title: "Plan" },
          { mode: "ask" },
          { bad: true },
        ],
      }),
      {
        currentModeId: "plan",
        availableModes: [
          { id: "agent", name: "Agent" },
          { id: "plan", name: "Plan" },
          { id: "ask" },
        ],
      },
    );

    assert.deepEqual(
      parseCursorSessionModelState({
        currentModelId: "gpt-5-mini[]",
        availableModels: [
          { modelId: "gpt-5-mini[]", name: "GPT-5 mini (current, default)" },
          { bad: true },
        ],
      }),
      {
        currentModelId: "gpt-5-mini[]",
        availableModels: [{ modelId: "gpt-5-mini[]", name: "GPT-5 mini" }],
      },
    );

    assert.deepEqual(
      parseCursorSessionModelState({
        current_model_id: "composer-2-fast",
        models: [
          { id: "composer-2-fast", label: "Composer 2 Fast (current)" },
          { value: "gpt-5.2", title: "GPT-5.2" },
          { model: "claude-opus-4.5" },
          { bad: true },
        ],
      }),
      {
        currentModelId: "composer-2-fast",
        availableModels: [
          { modelId: "composer-2-fast", name: "Composer 2 Fast" },
          { modelId: "gpt-5.2", name: "GPT-5.2" },
          { modelId: "claude-opus-4.5" },
        ],
      },
    );
  });

  it("strips Cursor current/default suffixes from config option labels", () => {
    const configOptions = parseCursorConfigOptions([
      {
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "composer-2-fast[]",
        options: [
          { value: "composer-2-fast[]", name: "Composer 2 Fast (current, default)" },
          { value: "gpt-5.1-codex-max[]", name: "GPT-5.1 Codex Max (default)" },
        ],
      },
    ]);

    assert.deepEqual(configOptions, [
      {
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "composer-2-fast[]",
        options: [
          { value: "composer-2-fast[]", name: "Composer 2 Fast" },
          { value: "gpt-5.1-codex-max[]", name: "GPT-5.1 Codex Max" },
        ],
      },
    ]);
  });

  it("parses Cursor MCP server maps from provider config shapes", () => {
    assert.deepEqual(
      parseCursorMcpServers({
        mcpServers: {
          browser: {
            command: "npx",
            args: ["-y", "@playwright/mcp"],
            env: { BROWSER_HEADLESS: "1" },
            tools: ["navigate", "screenshot"],
          },
          docs: {
            type: "http",
            url: "https://docs.example.test/mcp",
            headers: { Authorization: "Bearer token" },
          },
          malformed: { args: ["missing-command"] },
        },
      }),
      [
        {
          name: "browser",
          type: "stdio",
          command: "npx",
          args: ["-y", "@playwright/mcp"],
          tools: ["navigate", "screenshot"],
          env: { BROWSER_HEADLESS: "1" },
        },
        {
          name: "docs",
          type: "http",
          url: "https://docs.example.test/mcp",
          headers: { Authorization: "Bearer token" },
        },
      ],
    );
  });

  it("builds metadata by merging config options with explicit session state", () => {
    const configOptions = parseCursorConfigOptions([
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        currentValue: "agent",
        options: [
          { value: "agent", name: "Agent" },
          { value: "plan", name: "Plan" },
        ],
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "gpt-5-mini[]",
        options: [
          { value: "gpt-5-mini[]", name: "GPT-5 mini" },
          { value: "claude-4.6-opus[]", name: "Claude 4.6 Opus" },
        ],
      },
    ]);

    const metadata = buildCursorSessionMetadata({
      previous: EMPTY_CURSOR_SESSION_METADATA,
      initialize: parseCursorInitializeState({
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
      }),
      configOptions,
      currentModeId: "plan",
      currentModelId: "claude-4.6-opus[]",
      availableCommands: parseCursorAvailableCommands([
        { name: "search", description: "Search files" },
      ]),
      mcpServers: parseCursorMcpServers({
        mcpServers: {
          browser: { command: "npx", args: ["-y", "@playwright/mcp"] },
        },
      }),
    });

    assert.deepEqual(findCursorConfigOption(metadata.configOptions, { category: "mode" }), {
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "plan",
      options: [
        { value: "agent", name: "Agent" },
        { value: "plan", name: "Plan" },
      ],
    });
    assert.equal(metadata.modes?.currentModeId, "plan");
    assert.equal(metadata.models?.currentModelId, "claude-4.6-opus[]");
    assert.equal(metadata.defaultModeId, "plan");
    assert.deepEqual(metadata.availableCommands, [
      {
        name: "search",
        description: "Search files",
        kind: "provider",
        promptPrefix: "/search",
      },
    ]);
    assert.deepEqual(metadata.mcpServers, [
      {
        name: "browser",
        type: "stdio",
        command: "npx",
        args: ["-y", "@playwright/mcp"],
      },
    ]);
  });

  it("creates a compact metadata snapshot that omits empty optional fields", () => {
    const metadata = buildCursorSessionMetadata({
      previous: EMPTY_CURSOR_SESSION_METADATA,
      configOptions: [],
    });

    assert.deepEqual(cursorSessionMetadataSnapshot(metadata), {
      initialize: metadata.initialize,
      capabilities: {
        sessionForkMode: "local-replay",
        sessionResumeMode: "local-replay",
        sideConversationMode: "replay-fork",
      },
      configOptions: [],
    });
  });

  it("exposes native Cursor multi-agent capability when ACP advertises it", () => {
    const initialize = parseCursorInitializeState({
      agentCapabilities: {
        subagents: {
          enabled: true,
          invocationPrefixes: ["@", "@"],
          definitionPaths: [".cursor/agents/*.md"],
        },
      },
      _meta: {
        capabilities: {
          agentInvocationPrefixes: ["/agent"],
          agentDefinitionPaths: ["~/.cursor/agents/*.md"],
        },
      },
    });
    assert.equal(initialize.agentCapabilities.multiAgent, true);
    assert.deepEqual(initialize.agentCapabilities.multiAgentInvocationPrefixes, ["@", "/agent"]);
    assert.deepEqual(initialize.agentCapabilities.multiAgentDefinitionPaths, [
      ".cursor/agents/*.md",
      "~/.cursor/agents/*.md",
    ]);

    const metadata = buildCursorSessionMetadata({
      previous: EMPTY_CURSOR_SESSION_METADATA,
      initialize,
      configOptions: [],
    });

    assert.deepEqual(cursorSessionMetadataSnapshot(metadata).capabilities, {
      sessionForkMode: "local-replay",
      sessionResumeMode: "local-replay",
      sideConversationMode: "replay-fork",
      multiAgentMode: "native",
      multiAgentInvocationPrefixes: ["@", "/agent"],
      multiAgentDefinitionPaths: [".cursor/agents/*.md", "~/.cursor/agents/*.md"],
    });
  });

  it("parses available commands from wrapped ACP updates", () => {
    assert.deepEqual(
      parseCursorAvailableCommands({
        availableCommands: [{ name: "review", description: "Review changes" }],
      }),
      [
        {
          name: "review",
          description: "Review changes",
          kind: "provider",
          promptPrefix: "/review",
        },
      ],
    );
  });
});
