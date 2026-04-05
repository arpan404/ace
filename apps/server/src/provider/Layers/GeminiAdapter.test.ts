import { describe, expect, it } from "vitest";

import { buildGeminiInitializeParams, GEMINI_ACP_CLIENT_INFO } from "./GeminiAdapter.ts";

describe("buildGeminiInitializeParams", () => {
  it("declares filesystem capabilities required by older Gemini ACP builds", () => {
    expect(buildGeminiInitializeParams()).toEqual({
      protocolVersion: 1,
      clientInfo: GEMINI_ACP_CLIENT_INFO,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
      },
    });
  });
});
