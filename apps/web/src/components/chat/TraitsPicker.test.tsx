import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ServerProviderModel } from "@ace/contracts";

import { shouldRenderTraitsPicker, TraitsPicker } from "./TraitsPicker";

const COPILOT_WITHOUT_REASONING: ReadonlyArray<ServerProviderModel> = [
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

const COPILOT_WITH_REASONING: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5",
    name: "GPT-5",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
];

const OPENCODE_WITH_VARIANTS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "openai/gpt-5",
    name: "OpenAI: GPT-5",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [
        { value: "high", label: "High", isDefault: true },
        { value: "low", label: "Low" },
      ],
      promptInjectedEffortLevels: [],
    },
  },
];

const PI_WITH_REASONING: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "openai/gpt-5.5",
    name: "OpenAI: GPT-5.5",
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

const CLAUDE_WITHOUT_VISIBLE_TRAITS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
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

describe("TraitsPicker", () => {
  it("hides the Copilot selector when the model exposes no selectable traits", () => {
    const html = renderToStaticMarkup(
      <TraitsPicker
        provider="githubCopilot"
        models={COPILOT_WITHOUT_REASONING}
        model="gpt-4.1"
        prompt=""
        onPromptChange={() => undefined}
        modelOptions={{ reasoningEffort: "high" }}
        onModelOptionsChange={() => undefined}
      />,
    );

    expect(html).toBe("");
  });

  it("renders the Copilot selector when the model supports reasoning effort", () => {
    const html = renderToStaticMarkup(
      <TraitsPicker
        provider="githubCopilot"
        models={COPILOT_WITH_REASONING}
        model="gpt-5"
        prompt=""
        onPromptChange={() => undefined}
        modelOptions={{ reasoningEffort: "high" }}
        onModelOptionsChange={() => undefined}
      />,
    );

    expect(html).toContain("High");
  });

  it("renders Copilot agent config options as selectable traits", () => {
    const html = renderToStaticMarkup(
      <TraitsPicker
        provider="githubCopilot"
        models={COPILOT_WITHOUT_REASONING}
        model="gpt-4.1"
        prompt=""
        onPromptChange={() => undefined}
        modelOptions={{ agent: "security-auditor" }}
        onModelOptionsChange={() => undefined}
        sessionConfigOptions={[
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
        ]}
      />,
    );

    expect(html).toContain("Security Auditor");
  });

  it("shows the default OpenCode variant label in the trigger", () => {
    const html = renderToStaticMarkup(
      <TraitsPicker
        provider="opencode"
        models={OPENCODE_WITH_VARIANTS}
        model="openai/gpt-5"
        prompt=""
        onPromptChange={() => undefined}
        onModelOptionsChange={() => undefined}
      />,
    );

    expect(html).toContain("High");
    expect(html).not.toContain("Variant");
  });

  it("renders Pi reasoning traits from model capabilities before a session starts", () => {
    const html = renderToStaticMarkup(
      <TraitsPicker
        provider="pi"
        models={PI_WITH_REASONING}
        model="openai/gpt-5.5"
        prompt=""
        onPromptChange={() => undefined}
        onModelOptionsChange={() => undefined}
      />,
    );

    expect(html).toContain("Medium");
  });

  it("renders Claude output style config options as selectable traits", () => {
    const html = renderToStaticMarkup(
      <TraitsPicker
        provider="claudeAgent"
        models={CLAUDE_WITHOUT_VISIBLE_TRAITS}
        model="claude-sonnet-4-6"
        prompt=""
        onPromptChange={() => undefined}
        modelOptions={{ outputStyle: "Diagrams first" }}
        onModelOptionsChange={() => undefined}
        sessionConfigOptions={[
          {
            id: "output_style",
            name: "Style",
            category: "output_style",
            type: "select",
            currentValue: "Default",
            options: [
              { value: "Default", name: "Default" },
              { value: "Diagrams first", name: "Diagrams first" },
            ],
          },
        ]}
      />,
    );

    expect(html).toContain("Diagrams first");
  });

  it("renders Claude session agent config options as selectable traits", () => {
    const html = renderToStaticMarkup(
      <TraitsPicker
        provider="claudeAgent"
        models={CLAUDE_WITHOUT_VISIBLE_TRAITS}
        model="claude-sonnet-4-6"
        prompt=""
        onPromptChange={() => undefined}
        modelOptions={{ agent: "reviewer" }}
        onModelOptionsChange={() => undefined}
        sessionConfigOptions={[
          {
            id: "agent",
            name: "Agent",
            category: "agent",
            type: "select",
            currentValue: "default",
            options: [
              { value: "default", name: "Default" },
              { value: "reviewer", name: "reviewer" },
            ],
          },
        ]}
      />,
    );

    expect(html).toContain("reviewer");
  });

  it("renders Claude forked subagent config options as selectable traits", () => {
    const html = renderToStaticMarkup(
      <TraitsPicker
        provider="claudeAgent"
        models={CLAUDE_WITHOUT_VISIBLE_TRAITS}
        model="claude-sonnet-4-6"
        prompt=""
        onPromptChange={() => undefined}
        modelOptions={{ forkSubagents: true }}
        onModelOptionsChange={() => undefined}
        sessionConfigOptions={[
          {
            id: "fork_subagents",
            name: "Forks",
            category: "subagent_fork_mode",
            type: "select",
            currentValue: "off",
            options: [
              { value: "off", name: "Off" },
              { value: "on", name: "On" },
            ],
          },
        ]}
      />,
    );

    expect(html).toContain("Forks On");
    expect(html).toContain("On");
  });

  it("renders Claude agent teams config options as selectable traits", () => {
    const html = renderToStaticMarkup(
      <TraitsPicker
        provider="claudeAgent"
        models={CLAUDE_WITHOUT_VISIBLE_TRAITS}
        model="claude-sonnet-4-6"
        prompt=""
        onPromptChange={() => undefined}
        modelOptions={{ agentTeams: true }}
        onModelOptionsChange={() => undefined}
        sessionConfigOptions={[
          {
            id: "agent_teams",
            name: "Teams",
            category: "agent_team_mode",
            type: "select",
            currentValue: "off",
            options: [
              { value: "off", name: "Off" },
              { value: "on", name: "On" },
            ],
          },
        ]}
      />,
    );

    expect(html).toContain("Teams On");
    expect(html).toContain("On");
  });

  it("renders Cursor ACP mode config options as selectable traits", () => {
    const html = renderToStaticMarkup(
      <TraitsPicker
        provider="cursor"
        models={COPILOT_WITHOUT_REASONING}
        model="auto"
        prompt=""
        onPromptChange={() => undefined}
        modelOptions={{ modeId: "plan" }}
        onModelOptionsChange={() => undefined}
        sessionConfigOptions={[
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
        ]}
      />,
    );

    expect(html).toContain("Plan");
  });

  it("treats Cursor ACP mode options as visible traits without model variant controls", () => {
    expect(
      shouldRenderTraitsPicker({
        provider: "cursor",
        models: COPILOT_WITHOUT_REASONING,
        model: "auto",
        prompt: "",
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
      }),
    ).toBe(true);
  });

  it("renders Gemini ACP mode config options as selectable traits", () => {
    const html = renderToStaticMarkup(
      <TraitsPicker
        provider="gemini"
        models={COPILOT_WITHOUT_REASONING}
        model="gemini-2.5-pro"
        prompt=""
        onPromptChange={() => undefined}
        modelOptions={{ modeId: "yolo" }}
        onModelOptionsChange={() => undefined}
        sessionConfigOptions={[
          {
            id: "mode",
            name: "Mode",
            category: "mode",
            type: "select",
            currentValue: "default",
            options: [
              { value: "default", name: "Default" },
              { value: "yolo", name: "YOLO" },
            ],
          },
        ]}
      />,
    );

    expect(html).toContain("YOLO");
  });

  it("renders OpenCode primary agent mode config options as selectable traits", () => {
    const html = renderToStaticMarkup(
      <TraitsPicker
        provider="opencode"
        models={COPILOT_WITHOUT_REASONING}
        model="auto"
        prompt=""
        onPromptChange={() => undefined}
        modelOptions={{ modeId: "review" }}
        onModelOptionsChange={() => undefined}
        sessionConfigOptions={[
          {
            id: "mode",
            name: "Mode",
            category: "mode",
            type: "select",
            currentValue: "build",
            options: [
              { value: "build", name: "Build" },
              { value: "review", name: "Review" },
            ],
          },
        ]}
      />,
    );

    expect(html).toContain("Review");
  });
});
