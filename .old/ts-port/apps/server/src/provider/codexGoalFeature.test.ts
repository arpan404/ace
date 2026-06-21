import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearCodexGoalsFeatureCache,
  isCodexGoalsFeatureEnabled,
  parseCodexGoalsFeatureEnabled,
} from "./codexGoalFeature.ts";

afterEach(() => {
  clearCodexGoalsFeatureCache();
});

describe("codexGoalFeature", () => {
  it("detects enabled goals from codex features list output", () => {
    expect(
      parseCodexGoalsFeatureEnabled(`
apps                                stable             true
goals                               under development  true
tool_search                         stable             true
`),
    ).toBe(true);
  });

  it("keeps goals disabled when the feature is false or absent", () => {
    expect(
      parseCodexGoalsFeatureEnabled(`
apps                                stable             true
goals                               under development  false
`),
    ).toBe(false);
    expect(parseCodexGoalsFeatureEnabled("apps stable true")).toBe(false);
  });

  it("caches goal feature checks for the same Codex CLI configuration", () => {
    const spawnSync = vi.fn(() => ({
      status: 0,
      stdout: "goals under development true\n",
      stderr: "",
    })) as never;
    const input = {
      binaryPath: "codex",
      cwd: "/workspace",
      homePath: "/tmp/codex-home",
      launchEnv: {
        B: "2",
        A: "1",
      },
    };

    expect(isCodexGoalsFeatureEnabled(input, { spawnSync })).toBe(true);
    expect(isCodexGoalsFeatureEnabled(input, { spawnSync })).toBe(true);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });
});
