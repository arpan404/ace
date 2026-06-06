import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ServerProvider } from "./server";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

describe("ServerProvider", () => {
  it("accepts provider integration capabilities on provider status snapshots", () => {
    const parsed = decodeServerProvider({
      provider: "githubCopilot",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-06-06T00:00:00.000Z",
      models: [],
      capabilities: {
        sessionModelSwitch: "restart-session",
        sessionModelOptionsSwitch: "restart-session",
        liveTurnDiffMode: "workspace",
        reviewChangesMode: "git",
        approvalRequestsMode: "native",
        turnSteeringMode: "queued-message",
        transcriptAuthority: "local",
        sessionResumeMode: "native",
        sideConversationMode: "replay-fork",
        multiAgentMode: "native",
        multiAgentInvocationPrefixes: ["@", "/fleet"],
      },
    });

    expect(parsed.capabilities?.sideConversationMode).toBe("replay-fork");
    expect(parsed.capabilities?.multiAgentInvocationPrefixes).toEqual(["@", "/fleet"]);
  });
});
