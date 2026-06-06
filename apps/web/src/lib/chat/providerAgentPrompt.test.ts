import { describe, expect, it } from "vitest";

import { buildProviderAgentComposerPrompt } from "./providerAgentPrompt";

describe("buildProviderAgentComposerPrompt", () => {
  it("starts an empty draft with the provider agent invocation", () => {
    expect(
      buildProviderAgentComposerPrompt({
        currentPrompt: "",
        invocationPrompt: "@reviewer ",
      }),
    ).toBe("@reviewer ");
  });

  it("preserves an existing user draft by prefixing the provider agent invocation", () => {
    expect(
      buildProviderAgentComposerPrompt({
        currentPrompt: "Review the current diff.",
        invocationPrompt: "@reviewer ",
      }),
    ).toBe("@reviewer Review the current diff.");
  });

  it("does not duplicate an invocation that is already selected", () => {
    expect(
      buildProviderAgentComposerPrompt({
        currentPrompt: "@reviewer Review the current diff.",
        invocationPrompt: "@reviewer ",
      }),
    ).toBe("@reviewer Review the current diff.");
  });
});
