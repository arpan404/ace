import { describe, expect, it } from "vitest";

import { buildProviderCliUpgradePlan } from "./providerCliUpgrade";

describe("providerCliUpgrade", () => {
  it("uses bun when the resolved provider binary is installed in the bun global bin dir", () => {
    const plan = buildProviderCliUpgradePlan({
      provider: "gemini",
      runtimeId: "gemini",
      resolvedBinaryPath: "/Users/example/.bun/bin/gemini",
    });

    expect(plan).toMatchObject({
      kind: "package",
      packageManager: "bun",
      command: "/Users/example/.bun/bin/bun",
      args: ["add", "-g", "@google/gemini-cli@latest"],
    });
  });

  it("falls back to npm global install for generic PATH installs", () => {
    const plan = buildProviderCliUpgradePlan({
      provider: "codex",
      runtimeId: "codex",
      resolvedBinaryPath: "/opt/homebrew/bin/codex",
    });

    expect(plan).toMatchObject({
      kind: "package",
      packageManager: "npm",
      command: "npm",
      args: ["install", "-g", "@openai/codex@latest"],
    });
  });

  it("builds package-manager upgrade plans for Claude and Copilot", () => {
    expect(
      buildProviderCliUpgradePlan({
        provider: "claudeAgent",
        runtimeId: "claudeAgent",
        resolvedBinaryPath: "/usr/local/bin/claude",
      }).args,
    ).toEqual(["install", "-g", "@anthropic-ai/claude-code@latest"]);

    expect(
      buildProviderCliUpgradePlan({
        provider: "githubCopilot",
        runtimeId: "githubCopilot",
        resolvedBinaryPath: "/usr/local/bin/copilot",
      }),
    ).toMatchObject({
      args: ["install", "-g", "@github/copilot@latest"],
      fallback: {
        reason: "npm-bin-eexist",
        args: ["install", "-g", "--force", "@github/copilot@latest"],
      },
    });
  });

  it("builds self-update plans for Cursor and OpenCode", () => {
    expect(
      buildProviderCliUpgradePlan({
        provider: "cursor",
        runtimeId: "cursor",
        binaryPath: "cursor-agent",
        resolvedBinaryPath: "/usr/local/bin/cursor-agent",
      }),
    ).toMatchObject({
      kind: "self",
      command: "/usr/local/bin/cursor-agent",
      args: ["update"],
    });

    expect(
      buildProviderCliUpgradePlan({
        provider: "opencode",
        runtimeId: "opencode",
        binaryPath: "opencode",
        resolvedBinaryPath: "/usr/local/bin/opencode",
      }),
    ).toMatchObject({
      kind: "self",
      command: "/usr/local/bin/opencode",
      args: ["upgrade"],
    });
  });

  it("builds a deterministic runtime-specific upgrade plan for Pi", () => {
    const plan = buildProviderCliUpgradePlan({
      provider: "pi",
      runtimeId: "pi",
      resolvedBinaryPath: "/Users/example/.bun/bin/pi",
    });

    expect(plan).toMatchObject({
      kind: "package",
      packageManager: "bun",
      command: "/Users/example/.bun/bin/bun",
      args: ["add", "-g", "@mariozechner/pi-coding-agent@latest"],
    });
  });
});
