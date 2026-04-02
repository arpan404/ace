import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ServerProviderModel } from "@t3tools/contracts";

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
});
