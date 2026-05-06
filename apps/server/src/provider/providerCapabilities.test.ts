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
    });
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
