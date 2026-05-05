import { describe, expect, it } from "vitest";

import { buildProviderCliUpgradePlan } from "./providerCliUpgrade";

describe("providerCliUpgrade", () => {
  it("uses bun when the resolved provider binary is installed in the bun global bin dir", () => {
    const plan = buildProviderCliUpgradePlan({
      provider: "gemini",
      runtimeId: "gemini",
      resolvedBinaryPath: "/Users/example/.bun/bin/gemini",
    });

    expect(plan.packageManager).toBe("bun");
    expect(plan.command).toBe("/Users/example/.bun/bin/bun");
    expect(plan.args).toEqual(["add", "-g", "@google/gemini-cli@latest"]);
  });

  it("falls back to npm global install for generic PATH installs", () => {
    const plan = buildProviderCliUpgradePlan({
      provider: "codex",
      runtimeId: "codex",
      resolvedBinaryPath: "/opt/homebrew/bin/codex",
    });

    expect(plan.packageManager).toBe("npm");
    expect(plan.command).toBe("npm");
    expect(plan.args).toEqual(["install", "-g", "@openai/codex@latest"]);
  });

  it("rejects providers without a deterministic package upgrade command", () => {
    expect(() =>
      buildProviderCliUpgradePlan({
        provider: "cursor",
        runtimeId: "cursor",
        resolvedBinaryPath: "/usr/local/bin/cursor-agent",
      }),
    ).toThrow("One-click upgrade is not supported for this provider.");
  });

  it("builds a deterministic runtime-specific upgrade plan for Pi", () => {
    const plan = buildProviderCliUpgradePlan({
      provider: "pi",
      runtimeId: "pi",
      resolvedBinaryPath: "/Users/example/.bun/bin/pi",
    });

    expect(plan.packageManager).toBe("bun");
    expect(plan.command).toBe("/Users/example/.bun/bin/bun");
    expect(plan.args).toEqual(["add", "-g", "@mariozechner/pi-coding-agent@latest"]);
  });
});
