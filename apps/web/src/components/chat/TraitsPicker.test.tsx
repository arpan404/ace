import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ServerProviderModel } from "@ace/contracts";

import { TraitsPicker } from "./TraitsPicker";

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
});
