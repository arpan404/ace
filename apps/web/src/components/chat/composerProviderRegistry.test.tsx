import { describe, expect, it } from "vitest";
import { ThreadId, type ServerProviderModel } from "@ace/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import {
  getComposerProviderState,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderRegistry";

const CODEX_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5.4",
    name: "GPT-5.4",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
];

const CLAUDE_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
        { value: "max", label: "Max" },
        { value: "ultrathink", label: "Ultrathink" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: ["ultrathink"],
    },
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
        { value: "ultrathink", label: "Ultrathink" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: ["ultrathink"],
    },
  },
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: true,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
];

const CLAUDE_MODELS_WITH_CONTEXT_WINDOW: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
        { value: "max", label: "Max" },
        { value: "ultrathink", label: "Ultrathink" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [
        { value: "200k", label: "200k", isDefault: true },
        { value: "1m", label: "1M" },
      ],
      promptInjectedEffortLevels: ["ultrathink"],
    },
  },
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: true,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
];

const GITHUB_COPILOT_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5",
    name: "GPT-5",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
        { value: "xhigh", label: "Extra High" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "gpt-4.1",
    name: "GPT-4.1",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
];

const CURSOR_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5.3-codex-low",
    name: "GPT-5.3 Codex Low",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High" },
        { value: "medium", label: "Medium", isDefault: true },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
    cursorMetadata: {
      familySlug: "gpt-5.3-codex",
      familyName: "GPT-5.3 Codex",
      reasoningEffort: "low",
      fastMode: false,
      thinking: false,
      maxMode: false,
    },
  },
  {
    slug: "gpt-5.3-codex-low-fast",
    name: "GPT-5.3 Codex Low Fast",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High" },
        { value: "medium", label: "Medium", isDefault: true },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
    cursorMetadata: {
      familySlug: "gpt-5.3-codex",
      familyName: "GPT-5.3 Codex",
      reasoningEffort: "low",
      fastMode: true,
      thinking: false,
      maxMode: false,
    },
  },
];

const PI_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "openai/gpt-5.5",
    name: "GPT-5.5",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "minimal", label: "Minimal" },
        { value: "medium", label: "Medium", isDefault: true },
        { value: "high", label: "High" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
];

const GEMINI_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
];

describe("getComposerProviderState", () => {
  it("returns codex defaults when no codex draft options exist", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      models: CODEX_MODELS,
      prompt: "",
      modelOptions: undefined,
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "high",
      modelOptionsForDispatch: {
        reasoningEffort: "high",
      },
    });
  });

  it("normalizes codex dispatch options while preserving the selected effort", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      models: CODEX_MODELS,
      prompt: "",
      modelOptions: {
        codex: {
          reasoningEffort: "low",
          fastMode: true,
        },
      },
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "low",
      modelOptionsForDispatch: {
        reasoningEffort: "low",
        fastMode: true,
      },
    });
  });

  it("preserves codex fast mode when it is the only active option", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      models: CODEX_MODELS,
      prompt: "",
      modelOptions: {
        codex: {
          fastMode: true,
        },
      },
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "high",
      modelOptionsForDispatch: {
        reasoningEffort: "high",
        fastMode: true,
      },
    });
  });

  it("preserves codex default effort explicitly in dispatch options", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      models: CODEX_MODELS,
      prompt: "",
      modelOptions: {
        codex: {
          reasoningEffort: "high",
          fastMode: false,
        },
      },
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "high",
      modelOptionsForDispatch: {
        reasoningEffort: "high",
        fastMode: false,
      },
    });
  });

  it("preserves generic codex provider config in dispatch options", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      models: CODEX_MODELS,
      prompt: "",
      modelOptions: {
        codex: {
          providerConfig: {
            web_search: true,
          },
        },
      },
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "high",
      modelOptionsForDispatch: {
        reasoningEffort: "high",
        providerConfig: {
          web_search: true,
        },
      },
    });
  });

  it("returns Claude defaults for effort-capable models", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      models: CLAUDE_MODELS,
      prompt: "",
      modelOptions: undefined,
    });

    expect(state).toEqual({
      provider: "claudeAgent",
      promptEffort: "high",
      modelOptionsForDispatch: {
        effort: "high",
      },
    });
  });

  it("tracks Claude ultrathink from the prompt without changing dispatch effort", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      models: CLAUDE_MODELS,
      prompt: "Ultrathink:\nInvestigate this failure",
      modelOptions: {
        claudeAgent: {
          effort: "medium",
        },
      },
    });

    expect(state).toEqual({
      provider: "claudeAgent",
      promptEffort: "medium",
      modelOptionsForDispatch: {
        effort: "medium",
      },
      composerFrameClassName: "ultrathink-frame",
      composerSurfaceClassName: "ring-2 ring-primary/30",
      modelPickerIconClassName: "ultrathink-chroma",
    });
  });

  it("drops unsupported Claude effort options for models without effort controls", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-haiku-4-5",
      models: CLAUDE_MODELS,
      prompt: "",
      modelOptions: {
        claudeAgent: {
          effort: "max",
          thinking: false,
        },
      },
    });

    expect(state).toEqual({
      provider: "claudeAgent",
      promptEffort: null,
      modelOptionsForDispatch: {
        thinking: false,
      },
    });
  });

  it("preserves Claude fast mode when it is the only active option", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      models: CLAUDE_MODELS,
      prompt: "",
      modelOptions: {
        claudeAgent: {
          fastMode: true,
        },
      },
    });

    expect(state).toEqual({
      provider: "claudeAgent",
      promptEffort: "high",
      modelOptionsForDispatch: {
        effort: "high",
        fastMode: true,
      },
    });
  });

  it("preserves Claude default effort explicitly in dispatch options", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      models: CLAUDE_MODELS,
      prompt: "",
      modelOptions: {
        claudeAgent: {
          effort: "high",
          fastMode: false,
        },
      },
    });

    expect(state).toEqual({
      provider: "claudeAgent",
      promptEffort: "high",
      modelOptionsForDispatch: {
        effort: "high",
        fastMode: false,
      },
    });
  });

  it("preserves explicit fastMode: false so deepMerge can overwrite a prior true", () => {
    // Regression: normalizeClaudeModelOptionsWithCapabilities used to strip
    // fastMode: false, which meant deepMerge could never clear a previous true.
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      models: CLAUDE_MODELS,
      prompt: "",
      modelOptions: {
        claudeAgent: {
          effort: "high",
          fastMode: false,
        },
      },
    });

    expect(state.modelOptionsForDispatch).toHaveProperty("fastMode", false);
  });

  it("preserves explicit thinking: true so deepMerge can overwrite a prior false", () => {
    // Regression: thinking: true (the default) used to be stripped, which
    // meant deepMerge could never clear a previous thinking: false.
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-haiku-4-5",
      models: CLAUDE_MODELS,
      prompt: "",
      modelOptions: {
        claudeAgent: {
          thinking: true,
        },
      },
    });

    expect(state.modelOptionsForDispatch).toHaveProperty("thinking", true);
  });

  it("preserves Claude subagent model override in dispatch options", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      models: CLAUDE_MODELS,
      prompt: "",
      modelOptions: {
        claudeAgent: {
          subagentModel: "haiku",
        },
      },
    });

    expect(state.modelOptionsForDispatch).toHaveProperty("subagentModel", "haiku");
  });

  it("preserves Claude default context window explicitly in dispatch options", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      models: CLAUDE_MODELS_WITH_CONTEXT_WINDOW,
      prompt: "",
      modelOptions: {
        claudeAgent: {
          effort: "high",
          contextWindow: "200k",
        },
      },
    });

    expect(state.modelOptionsForDispatch).toMatchObject({
      effort: "high",
      contextWindow: "200k",
    });
  });

  it("preserves explicit contextWindow default so deepMerge can overwrite a prior 1m", () => {
    // Regression: the default contextWindow must survive normalization so
    // deepMerge can clear an older non-default 1m selection.
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      models: CLAUDE_MODELS_WITH_CONTEXT_WINDOW,
      prompt: "",
      modelOptions: {
        claudeAgent: {
          contextWindow: "200k",
        },
      },
    });

    expect(state.modelOptionsForDispatch).toHaveProperty("contextWindow", "200k");
  });

  it("omits contextWindow when the model does not support it", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-haiku-4-5",
      models: CLAUDE_MODELS_WITH_CONTEXT_WINDOW,
      prompt: "",
      modelOptions: {
        claudeAgent: {
          contextWindow: "1m",
        },
      },
    });

    expect(state.modelOptionsForDispatch).toBeUndefined();
  });

  it("omits fastMode when the model does not support it", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      models: CLAUDE_MODELS,
      prompt: "",
      modelOptions: {
        claudeAgent: {
          effort: "high",
          fastMode: true,
        },
      },
    });

    expect(state.modelOptionsForDispatch).not.toHaveProperty("fastMode");
  });

  it("returns Copilot defaults for reasoning-capable models", () => {
    const state = getComposerProviderState({
      provider: "githubCopilot",
      model: "gpt-5",
      models: GITHUB_COPILOT_MODELS,
      prompt: "",
      modelOptions: undefined,
    });

    expect(state).toEqual({
      provider: "githubCopilot",
      promptEffort: "high",
      modelOptionsForDispatch: {
        reasoningEffort: "high",
      },
    });
  });

  it("drops Copilot reasoning effort for models without reasoning controls", () => {
    const state = getComposerProviderState({
      provider: "githubCopilot",
      model: "gpt-4.1",
      models: GITHUB_COPILOT_MODELS,
      prompt: "",
      modelOptions: {
        githubCopilot: {
          reasoningEffort: "high",
        },
      },
    });

    expect(state).toEqual({
      provider: "githubCopilot",
      promptEffort: null,
      modelOptionsForDispatch: undefined,
    });
  });

  it("dispatches Cursor model traits so ACP can select the matching variant", () => {
    const state = getComposerProviderState({
      provider: "cursor",
      model: "gpt-5.3-codex-low-fast",
      models: CURSOR_MODELS,
      prompt: "",
      modelOptions: {
        cursor: {
          reasoningEffort: "low",
          fastMode: true,
        },
      },
    });

    expect(state).toEqual({
      provider: "cursor",
      promptEffort: null,
      modelOptionsForDispatch: {
        reasoningEffort: "low",
        fastMode: true,
      },
    });
  });

  it("normalizes Pi reasoning effort into Pi thought-level dispatch options", () => {
    const state = getComposerProviderState({
      provider: "pi",
      model: "openai/gpt-5.5",
      models: PI_MODELS,
      prompt: "",
      modelOptions: {
        pi: {
          reasoningEffort: "high",
        },
      },
    });

    expect(state).toEqual({
      provider: "pi",
      promptEffort: "high",
      modelOptionsForDispatch: {
        thoughtLevel: "high",
        reasoningEffort: "high",
      },
    });
  });

  it("preserves Pi minimal thought level in the composer provider state", () => {
    const state = getComposerProviderState({
      provider: "pi",
      model: "openai/gpt-5.5",
      models: PI_MODELS,
      prompt: "",
      modelOptions: {
        pi: {
          thoughtLevel: "minimal",
        },
      },
    });

    expect(state).toEqual({
      provider: "pi",
      promptEffort: "minimal",
      modelOptionsForDispatch: {
        thoughtLevel: "minimal",
      },
    });
  });

  it("preserves Gemini ACP mode in dispatch options", () => {
    const state = getComposerProviderState({
      provider: "gemini",
      model: "gemini-2.5-pro",
      models: GEMINI_MODELS,
      prompt: "",
      modelOptions: {
        gemini: {
          modeId: "yolo",
        },
      },
    });

    expect(state).toEqual({
      provider: "gemini",
      promptEffort: null,
      modelOptionsForDispatch: {
        modeId: "yolo",
      },
    });
  });

  it("preserves OpenCode primary agent mode in dispatch options", () => {
    const state = getComposerProviderState({
      provider: "opencode",
      model: "auto",
      models: [
        {
          slug: "auto",
          name: "Auto",
          isCustom: false,
          capabilities: {
            reasoningEffortLevels: [],
            promptInjectedEffortLevels: [],
            supportsThinkingToggle: false,
            supportsFastMode: false,
            contextWindowOptions: [],
          },
        },
      ],
      prompt: "",
      modelOptions: {
        opencode: {
          modeId: "review",
        },
      },
    });

    expect(state).toEqual({
      provider: "opencode",
      promptEffort: null,
      modelOptionsForDispatch: {
        modeId: "review",
      },
    });
  });
});

describe("renderProviderTraitsPicker", () => {
  it("returns null when the selected provider model exposes no visible traits", () => {
    const picker = renderProviderTraitsPicker({
      provider: "githubCopilot",
      threadId: ThreadId.makeUnsafe("thread-1"),
      model: "gpt-4.1",
      models: GITHUB_COPILOT_MODELS,
      modelOptions: undefined,
      prompt: "",
      onPromptChange: () => undefined,
    });

    expect(picker).toBeNull();
  });

  it("renders Cursor traits picker when the selected family exposes variant controls", () => {
    const picker = renderProviderTraitsPicker({
      provider: "cursor",
      threadId: ThreadId.makeUnsafe("thread-1"),
      model: "gpt-5.3-codex-low-fast",
      models: CURSOR_MODELS,
      modelOptions: undefined,
      prompt: "",
      onPromptChange: () => undefined,
    });

    expect(picker).not.toBeNull();
  });

  it("renders Cursor traits picker when ACP mode config options are available", () => {
    const picker = renderProviderTraitsPicker({
      provider: "cursor",
      threadId: ThreadId.makeUnsafe("thread-1"),
      model: "auto",
      models: GITHUB_COPILOT_MODELS,
      modelOptions: { modeId: "plan" },
      prompt: "",
      onPromptChange: () => undefined,
      sessionConfigOptions: [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "agent",
          options: [
            { value: "agent", name: "Agent" },
            { value: "plan", name: "Plan" },
          ],
        },
      ],
    });

    expect(picker).not.toBeNull();
  });

  it("renders GitHub Copilot agent config options in the traits picker", () => {
    const picker = renderProviderTraitsPicker({
      provider: "githubCopilot",
      threadId: ThreadId.makeUnsafe("thread-1"),
      model: "gpt-4.1",
      models: GITHUB_COPILOT_MODELS,
      modelOptions: { agent: "security-auditor" },
      prompt: "",
      onPromptChange: () => undefined,
      sessionConfigOptions: [
        {
          id: "agent",
          name: "Agent",
          category: "agent",
          type: "select",
          currentValue: "default",
          options: [
            { value: "default", name: "Default" },
            { value: "security-auditor", name: "Security Auditor" },
          ],
        },
      ],
    });

    expect(renderToStaticMarkup(<>{picker}</>)).toContain("Security Auditor");
  });

  it("renders Codex generic config options in the traits picker", () => {
    const picker = renderProviderTraitsPicker({
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      model: "gpt-5.4",
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          isCustom: false,
          capabilities: {
            reasoningEffortLevels: [],
            promptInjectedEffortLevels: [],
            supportsThinkingToggle: false,
            supportsFastMode: false,
            contextWindowOptions: [],
          },
        },
      ],
      modelOptions: {
        providerConfig: {
          web_search: true,
        },
      },
      prompt: "",
      onPromptChange: () => undefined,
      sessionConfigOptions: [
        {
          id: "web_search",
          name: "Web Search",
          type: "boolean",
          currentValue: "off",
          options: [],
        },
      ],
    });

    expect(renderToStaticMarkup(<>{picker}</>)).toContain("Web Search On");
  });
});

describe("renderProviderTraitsMenuContent", () => {
  it("returns null when the selected provider model exposes no visible traits", () => {
    const menuContent = renderProviderTraitsMenuContent({
      provider: "githubCopilot",
      threadId: ThreadId.makeUnsafe("thread-1"),
      model: "gpt-4.1",
      models: GITHUB_COPILOT_MODELS,
      modelOptions: undefined,
      prompt: "",
      onPromptChange: () => undefined,
    });

    expect(menuContent).toBeNull();
  });

  it("renders Cursor traits menu content when ACP mode config options are available", () => {
    const menuContent = renderProviderTraitsMenuContent({
      provider: "cursor",
      threadId: ThreadId.makeUnsafe("thread-1"),
      model: "auto",
      models: GITHUB_COPILOT_MODELS,
      modelOptions: { modeId: "plan" },
      prompt: "",
      onPromptChange: () => undefined,
      sessionConfigOptions: [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "agent",
          options: [
            { value: "agent", name: "Agent" },
            { value: "plan", name: "Plan" },
          ],
        },
      ],
    });

    expect(menuContent).not.toBeNull();
  });

  it("renders GitHub Copilot agent config options in the traits menu content", () => {
    const sessionConfigOptions = [
      {
        id: "agent",
        name: "Agent",
        category: "agent" as const,
        type: "select" as const,
        currentValue: "default",
        options: [
          { value: "default", name: "Default" },
          { value: "security-auditor", name: "Security Auditor" },
        ],
      },
    ];
    const menuContent = renderProviderTraitsMenuContent({
      provider: "githubCopilot",
      threadId: ThreadId.makeUnsafe("thread-1"),
      model: "gpt-4.1",
      models: GITHUB_COPILOT_MODELS,
      modelOptions: { agent: "security-auditor" },
      prompt: "",
      onPromptChange: () => undefined,
      sessionConfigOptions,
    });

    expect((menuContent as { props?: { sessionConfigOptions?: unknown } }).props).toMatchObject({
      sessionConfigOptions,
    });
  });

  it("routes Cursor generic config options through the shared traits menu", () => {
    const menuContent = renderProviderTraitsMenuContent({
      provider: "cursor",
      threadId: ThreadId.makeUnsafe("thread-1"),
      model: "auto",
      models: GITHUB_COPILOT_MODELS,
      modelOptions: {
        providerConfig: {
          web_search: true,
        },
      },
      prompt: "",
      onPromptChange: () => undefined,
      sessionConfigOptions: [
        {
          id: "web_search",
          name: "Web Search",
          type: "boolean",
          currentValue: "off",
          options: [],
        },
      ],
    });

    expect((menuContent as { props?: { provider?: unknown } }).props).toMatchObject({
      provider: "cursor",
    });
  });
});
