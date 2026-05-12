import { describe, expect, it } from "vitest";
import type { ServerProvider } from "@ace/contracts";

import { getProviderSummary } from "./SettingsPanelPrimitives";

function buildProvider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    provider: "gemini",
    enabled: true,
    installed: true,
    version: "0.12.0",
    minimumVersion: "0.40.0",
    versionStatus: "upgrade-required",
    status: "warning",
    auth: { status: "unknown" },
    checkedAt: "2026-05-02T00:00:00.000Z",
    message:
      "Upgrade needed: Gemini CLI v0.12.0 is below ace's minimum supported version v0.40.0. Upgrade Gemini CLI and restart ace.",
    models: [],
    ...overrides,
  };
}

describe("getProviderSummary", () => {
  it("shows outdated providers as upgrade needed instead of unavailable", () => {
    const summary = getProviderSummary(buildProvider());

    expect(summary.headline).toBe("Upgrade needed");
    expect(summary.detail).toContain("v0.40.0");
  });

  it("still shows actual provider errors as unavailable", () => {
    const summary = getProviderSummary(
      buildProvider({
        versionStatus: "ok",
        status: "error",
        message: "Gemini CLI failed to run.",
      }),
    );

    expect(summary.headline).toBe("Unavailable");
  });
});
