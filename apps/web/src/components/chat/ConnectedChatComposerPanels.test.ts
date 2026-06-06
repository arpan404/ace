import { describe, expect, it } from "vitest";

import { isComposerVisibleProviderCommand } from "./ConnectedChatComposerPanels";

describe("ConnectedChatComposerPanels command visibility", () => {
  it("hides provider commands owned by Ace-native UI flows", () => {
    expect(isComposerVisibleProviderCommand({ name: "goal", kind: "provider" })).toBe(false);
    expect(isComposerVisibleProviderCommand({ name: "side", kind: "provider" })).toBe(false);
    expect(isComposerVisibleProviderCommand({ name: "/side", kind: "provider" })).toBe(false);
    expect(isComposerVisibleProviderCommand({ name: ".side", kind: "provider" })).toBe(false);
    expect(isComposerVisibleProviderCommand({ name: "/.side", kind: "provider" })).toBe(false);
    expect(isComposerVisibleProviderCommand({ name: "btw", kind: "provider" })).toBe(false);
    expect(isComposerVisibleProviderCommand({ name: "/btw", kind: "provider" })).toBe(false);
    expect(isComposerVisibleProviderCommand({ name: ".btw", kind: "provider" })).toBe(false);
  });

  it("keeps provider extension commands visible", () => {
    expect(isComposerVisibleProviderCommand({ name: "reviewer", kind: "agent" })).toBe(true);
    expect(isComposerVisibleProviderCommand({ name: "frontend/component", kind: "skill" })).toBe(
      true,
    );
  });

  it("keeps provider-kind remote agents visible when metadata identifies them as agents", () => {
    expect(
      isComposerVisibleProviderCommand({
        name: "remote-reviewer",
        kind: "provider",
        promptPrefix: "@remote-reviewer",
        metadata: {
          source: "remote-agent",
          agentCardUrl: "https://example.com/.well-known/agent.json",
        },
      }),
    ).toBe(true);
  });
});
