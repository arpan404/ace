import { describe, expect, it } from "vitest";

import {
  applyTerminalInputToBuffer,
  buildTerminalFallbackTitle,
  deriveTerminalTitleFromCommand,
  extractTerminalOscTitle,
  normalizeTerminalDisplayTitle,
  normalizeTerminalPaneRatios,
  resolveTerminalDisplayTitle,
  resizeTerminalPaneRatios,
} from "./terminalPresentation";

describe("deriveTerminalTitleFromCommand", () => {
  it("extracts useful titles from common package manager commands", () => {
    expect(deriveTerminalTitleFromCommand("bun run dev")).toBe("bun dev");
    expect(deriveTerminalTitleFromCommand("npm test")).toBe("npm test");
    expect(deriveTerminalTitleFromCommand("pnpm lint && pnpm typecheck")).toBe("pnpm lint");
  });

  it("handles git, docker compose, and script runtimes", () => {
    expect(deriveTerminalTitleFromCommand("git status")).toBe("git status");
    expect(deriveTerminalTitleFromCommand("docker compose up")).toBe("docker compose up");
    expect(deriveTerminalTitleFromCommand("python scripts/release.py")).toBe("python release.py");
    expect(deriveTerminalTitleFromCommand('bash -lc "rg queuedSteerRequest src"')).toBe("rg");
    expect(deriveTerminalTitleFromCommand("oa --model gpt-5.4 bun run dev")).toBe("bun dev");
    expect(deriveTerminalTitleFromCommand("oa")).toBeNull();
  });
});

describe("applyTerminalInputToBuffer", () => {
  it("tracks typed text and yields a submitted command on enter", () => {
    const first = applyTerminalInputToBuffer("", "bun run dev");
    expect(first).toEqual({ buffer: "bun run dev", submittedCommand: null });
    const second = applyTerminalInputToBuffer(first.buffer, "\r");
    expect(second).toEqual({ buffer: "", submittedCommand: "bun run dev" });
  });

  it("supports backspace and clear shortcuts", () => {
    expect(applyTerminalInputToBuffer("bun run devx", "\u007f")).toEqual({
      buffer: "bun run dev",
      submittedCommand: null,
    });
    expect(applyTerminalInputToBuffer("bun run dev", "\u0015")).toEqual({
      buffer: "",
      submittedCommand: null,
    });
  });
});

describe("extractTerminalOscTitle", () => {
  it("reads OSC 0 and OSC 2 terminal titles", () => {
    expect(extractTerminalOscTitle("\u001b]0;bun dev\u0007")).toBe("bun dev");
    expect(extractTerminalOscTitle("\u001b]2;git status\u001b\\")).toBe("git status");
    expect(extractTerminalOscTitle("\u001b]0;oa\u0007")).toBeNull();
  });
});

describe("terminal pane ratios", () => {
  it("normalizes invalid ratio input", () => {
    expect(normalizeTerminalPaneRatios([], 3)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("resizes adjacent panes while preserving the total", () => {
    const resized = resizeTerminalPaneRatios({
      ratios: [0.5, 0.5],
      dividerIndex: 0,
      deltaPx: 120,
      containerWidthPx: 600,
      minPaneWidthPx: 160,
    });
    expect(resized[0]).toBeCloseTo(0.7, 2);
    expect(resized[1]).toBeCloseTo(0.3, 2);
  });
});

describe("buildTerminalFallbackTitle", () => {
  it("returns the generic terminal label independent of cwd or id", () => {
    expect(buildTerminalFallbackTitle("/Users/arpanbhandari/Code/ace", "default")).toBe("Terminal");
    expect(buildTerminalFallbackTitle("/Users/arpanbhandari/Code/ace", "terminal-2")).toBe(
      "Terminal",
    );
    expect(buildTerminalFallbackTitle("/Users/arpanbhandari/Code/ace", "terminal-abc123")).toBe(
      "Terminal",
    );
  });
});

describe("normalizeTerminalDisplayTitle", () => {
  it("keeps command-derived titles", () => {
    expect(normalizeTerminalDisplayTitle("bun run dev")).toBe("bun dev");
    expect(normalizeTerminalDisplayTitle("bun dev")).toBe("bun dev");
    expect(normalizeTerminalDisplayTitle("git status")).toBe("git status");
    expect(normalizeTerminalDisplayTitle("docker compose up")).toBe("docker compose up");
    expect(normalizeTerminalDisplayTitle("rg queued src")).toBe("rg");
  });

  it("rejects generated terminal and shell titles", () => {
    expect(normalizeTerminalDisplayTitle("Terminal EC9E")).toBeNull();
    expect(normalizeTerminalDisplayTitle("Workspace shell")).toBeNull();
    expect(normalizeTerminalDisplayTitle("zsh")).toBeNull();
  });
});

describe("resolveTerminalDisplayTitle", () => {
  it("shows command-derived titles only while the terminal is running", () => {
    const base = {
      autoTitle: "clear",
      cwd: "/Users/arpanbhandari/Code/ace",
      terminalId: "terminal-2",
    };

    expect(resolveTerminalDisplayTitle({ ...base, isRunning: true })).toBe("clear");
    expect(resolveTerminalDisplayTitle({ ...base, isRunning: false })).toBe("Terminal");
  });

  it("falls back to Terminal for non-command generated titles", () => {
    expect(
      resolveTerminalDisplayTitle({
        autoTitle: "Terminal EC9E",
        cwd: "/Users/arpanbhandari/Code/ace",
        isRunning: true,
        terminalId: "terminal-2",
      }),
    ).toBe("Terminal");
  });
});
