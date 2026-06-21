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
    expect(defaultProviderIntegrationCapabilities("githubCopilot").sessionForkMode).toBe("native");
    expect(defaultProviderIntegrationCapabilities("opencode").sessionForkMode).toBe("native");
  });

  it("preserves Pi defaults when adapter capabilities do not override them", () => {
    expect(
      resolveProviderIntegrationCapabilities("pi", { sessionModelSwitch: "in-session" }),
    ).toMatchObject({
      approvalRequestsMode: "none",
      turnSteeringMode: "native",
    });
  });
});
