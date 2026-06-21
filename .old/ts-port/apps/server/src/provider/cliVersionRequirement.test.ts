import { describe, expect, it } from "vitest";

import {
  compareCliVersions,
  formatCliUpgradeMessage,
  getCliVersionStatus,
  isCliVersionAtLeast,
  normalizeParsedCliVersion,
} from "./cliVersionRequirement";

describe("cliVersionRequirement", () => {
  it("compares semver versions with prerelease ordering", () => {
    expect(compareCliVersions("0.33.0", "0.33.0")).toBe(0);
    expect(isCliVersionAtLeast("0.34.0", "0.33.0")).toBe(true);
    expect(isCliVersionAtLeast("0.12.0", "0.33.0")).toBe(false);
    expect(isCliVersionAtLeast("0.33.0-nightly.20260301", "0.33.0")).toBe(false);
  });

  it("normalizes versions with a leading v and missing patch segment", () => {
    expect(normalizeParsedCliVersion("v1.2")).toBe("1.2.0");
    expect(normalizeParsedCliVersion("not-a-version")).toBeNull();
  });

  it("classifies minimum version requirements", () => {
    expect(getCliVersionStatus("0.33.0", "0.33.0")).toBe("ok");
    expect(getCliVersionStatus("0.12.0", "0.33.0")).toBe("upgrade-required");
    expect(getCliVersionStatus(null, "0.33.0")).toBe("unknown");
  });

  it("formats upgrade messages consistently", () => {
    expect(
      formatCliUpgradeMessage({
        providerLabel: "Gemini",
        version: "0.12.0",
        minimumVersion: "0.33.0",
      }),
    ).toBe(
      "Upgrade needed: Gemini CLI v0.12.0 is below ace's minimum supported version v0.33.0. Upgrade Gemini CLI and restart ace.",
    );
  });
});
