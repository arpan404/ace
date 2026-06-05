import { describe, expect, it } from "vitest";

import {
  resolveTerminalGroupPaneRatios,
  resolveTerminalTabDropTarget,
  resolveTerminalSelectionActionPosition,
  shouldHandleTerminalSelectionMouseUp,
  terminalFitSignature,
  terminalSelectionActionDelayForClickCount,
} from "./ThreadTerminalDrawer";

describe("resolveTerminalTabDropTarget", () => {
  it("resolves the group and insertion index for tab sorting", () => {
    expect(
      resolveTerminalTabDropTarget(
        [
          { id: "group-default", terminalIds: ["default", "terminal-2"] },
          { id: "group-terminal-3", terminalIds: ["terminal-3"] },
        ],
        "terminal-2",
      ),
    ).toEqual({ groupId: "group-default", index: 1 });
  });

  it("returns null when the target terminal is not open", () => {
    expect(
      resolveTerminalTabDropTarget([{ id: "group-default", terminalIds: ["default"] }], "missing"),
    ).toBeNull();
  });
});

describe("resolveTerminalGroupPaneRatios", () => {
  it("normalizes valid pane ratios", () => {
    expect(resolveTerminalGroupPaneRatios([2, 1, 1], 3)).toEqual([0.5, 0.25, 0.25]);
  });

  it("falls back to equal ratios when stored ratios do not match the group", () => {
    expect(resolveTerminalGroupPaneRatios([0.7, 0.3], 3)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("falls back to equal ratios when all stored ratios are invalid", () => {
    expect(resolveTerminalGroupPaneRatios([0, -1], 2)).toEqual([0.5, 0.5]);
  });
});

describe("terminalFitSignature", () => {
  it("includes both viewport pixels and terminal geometry", () => {
    expect(terminalFitSignature({ width: 1200, height: 300, cols: 132, rows: 18 })).toBe(
      "1200x300:132x18",
    );
  });
});

describe("resolveTerminalSelectionActionPosition", () => {
  it("prefers the selection rect over the last pointer position", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: { right: 260, bottom: 140 },
        pointer: { x: 520, y: 200 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 260,
      y: 144,
    });
  });

  it("falls back to the pointer position when no selection rect is available", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 180, y: 130 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 180,
      y: 130,
    });
  });

  it("clamps the pointer fallback into the terminal drawer bounds", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 720, y: 340 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 600,
      y: 270,
    });

    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 40, y: 20 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("delays multi-click selection actions so triple-click selection can complete", () => {
    expect(terminalSelectionActionDelayForClickCount(1)).toBe(0);
    expect(terminalSelectionActionDelayForClickCount(2)).toBe(260);
    expect(terminalSelectionActionDelayForClickCount(3)).toBe(260);
  });

  it("only handles mouseup when the selection gesture started in the terminal", () => {
    expect(shouldHandleTerminalSelectionMouseUp(true, 0)).toBe(true);
    expect(shouldHandleTerminalSelectionMouseUp(false, 0)).toBe(false);
    expect(shouldHandleTerminalSelectionMouseUp(true, 1)).toBe(false);
  });
});
