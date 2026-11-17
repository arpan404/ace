import { describe, expect, it } from "vitest";
import { askBeforeAgentPublish, type SettingReader } from "./market-agent.ts";

/** A settings service that answers `get` with `answer`, or throws it. */
function settings(answer: unknown): SettingReader {
  return {
    get: async () => {
      if (answer instanceof Error) throw answer;
      return { value: answer };
    },
  };
}

describe("Ask me before agents publish fails closed", () => {
  it("is off only when the person's setting reads off", async () => {
    expect(await askBeforeAgentPublish(settings(false))).toBe(false);
    expect(await askBeforeAgentPublish(settings(true))).toBe(true);
  });

  it("counts as on when settings aren't loaded yet", async () => {
    expect(await askBeforeAgentPublish(undefined)).toBe(true);
  });

  it("counts as on when settings can't be read", async () => {
    expect(await askBeforeAgentPublish(settings(new Error("settings file unreadable")))).toBe(true);
  });

  it("counts as on when the value isn't a boolean", async () => {
    expect(await askBeforeAgentPublish(settings(undefined))).toBe(true);
    expect(await askBeforeAgentPublish(settings("no"))).toBe(true);
  });
});
