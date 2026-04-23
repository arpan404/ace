import { describe, expect, it } from "vitest";

import {
  appendTerminalContextsToPrompt,
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
} from "./terminalContext";

describe("appendTerminalContextsToPrompt", () => {
  it("materializes inline placeholders and appends terminal context blocks", () => {
    const prompt = appendTerminalContextsToPrompt(
      `Investigate ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}`,
      [
        {
          terminalId: "term-1",
          terminalLabel: "Terminal 1",
          lineStart: 12,
          lineEnd: 13,
          text: "alpha\nbeta",
        },
      ],
    );

    expect(prompt).toContain("Investigate @terminal-1:12-13");
    expect(prompt).toContain("<terminal_context>");
    expect(prompt).toContain("- Terminal 1 lines 12-13:");
    expect(prompt).toContain("  12 | alpha");
    expect(prompt).toContain("  13 | beta");
  });
});
