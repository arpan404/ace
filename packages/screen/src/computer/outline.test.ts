import { describe, expect, it } from "vitest";
import {
  baselineOf,
  findLines,
  idRanges,
  nodeLine,
  outlineBody,
  outlineLines,
  stateFooter,
  stateHeader,
} from "./outline.ts";
import { ComputerState, type ComputerNode } from "./wire.ts";

const window: ComputerNode = { id: 1, depth: 0, role: "standard window", name: "Calculator" };
const field: ComputerNode = { id: 5, depth: 1, role: "scroll area", name: "Edit field" };
const display: ComputerNode = { id: 6, depth: 2, role: "text", name: "0" };
const seven: ComputerNode = { id: 23, depth: 1, role: "button", name: "7" };
const equals: ComputerNode = { id: 56, depth: 1, role: "button", name: "Equals" };
const calculator = [window, field, display, seven, equals];

function state(nodes: ComputerNode[], extra: Record<string, unknown> = {}) {
  return ComputerState.parse({
    app: { name: "Calculator", bundleId: "com.apple.calculator", pid: 7 },
    windows: [{ index: 1, title: "Calculator", onScreen: false, current: true }],
    window: { title: "Calculator", width: 674, height: 408, onScreen: false },
    nodes,
    menuBar: ["Calculator", "Edit"],
    ...extra,
  });
}

describe("element lines", () => {
  it("show flags, value, description, placeholder, link and actions in one readable line", () => {
    expect(
      nodeLine({
        id: 9,
        depth: 0,
        role: "text field",
        flags: ["focused"],
        name: "To",
        value: "ada@example.com\nbob",
        detail: "Recipients",
        placeholder: "Add people",
        actions: ["confirm"],
      }),
    ).toBe(
      "9 text field (focused) To, Value: ada@example.com\\nbob, Description: Recipients, Placeholder: Add people, Actions: confirm",
    );
  });
});

describe("observing again", () => {
  const first = outlineLines(calculator);

  it("returns the whole indented outline the first time", () => {
    const body = outlineBody(first, "7:1", undefined);
    expect(body.kind).toBe("full");
    expect(body.text).toBe(
      "1 standard window Calculator\n\t5 scroll area Edit field\n\t\t6 text 0\n\t23 button 7\n\t56 button Equals",
    );
  });

  it("says nothing changed when the window is the same", () => {
    expect(outlineBody(first, "7:1", baselineOf(first, "7:1"))).toEqual({
      kind: "unchanged",
      text: "No change since your last look.",
    });
  });

  it("shows only changed and new elements, with their parents for context and removals as ranges", () => {
    const after = outlineLines([
      window,
      field,
      { ...display, name: "408" },
      { id: 70, depth: 2, role: "text", name: "12×34" },
      equals,
    ]);
    const body = outlineBody(after, "7:1", baselineOf(first, "7:1"));
    expect(body.kind).toBe("diff");
    expect(body.text.split("\n").slice(1)).toEqual([
      " 1 standard window Calculator",
      " \t5 scroll area Edit field",
      "~\t\t6 text 408",
      "+\t\t70 text 12×34",
      "Removed: 23",
    ]);
  });

  it("returns the full outline when a different window is observed", () => {
    expect(outlineBody(first, "7:99", baselineOf(first, "7:1")).kind).toBe("full");
  });

  it("returns the full outline when most of the window changed", () => {
    const replaced = outlineLines(calculator.map((node) => ({ ...node, name: `${node.name}!` })));
    expect(outlineBody(replaced, "7:1", baselineOf(first, "7:1")).kind).toBe("full");
  });
});

describe("searching a window", () => {
  it("lists matches under their parents and counts them", () => {
    expect(findLines(outlineLines(calculator), "equal")).toBe(
      '1 element match "equal":\n1 standard window Calculator\n\t56 button Equals',
    );
  });

  it("says when nothing matches", () => {
    expect(findLines(outlineLines(calculator), "sine")).toBe(
      'Nothing in the window matches "sine".',
    );
  });
});

describe("id ranges", () => {
  it("collapse consecutive ids", () => {
    expect(idRanges([9, 3, 4, 5, 12, 13])).toBe("3-5, 9, 12-13");
  });
});

describe("header and footer", () => {
  it("tell the model the window is off screen and how to switch windows", () => {
    const header = stateHeader(
      state(calculator, {
        windows: [
          { index: 1, title: "A", current: true },
          { index: 2, title: "B", minimized: true },
        ],
      }),
    );
    expect(header).toContain("in the background");
    expect(header).toContain("off screen");
    expect(header).toContain('Windows: 1 "A" (shown), 2 "B" (minimized). Pass window to switch.');
  });

  it("point an app without windows at its menu bar", () => {
    expect(stateHeader(state([], { window: undefined, windows: [] }))).toContain(
      'No open windows. Open one through the menu bar, e.g. menu ["File", "New"].',
    );
  });

  it("report focus, the menu bar on full outlines, and screenshot coordinates", () => {
    const footer = stateFooter(
      state(calculator, {
        focused: { id: 6, role: "text", selectedText: "40" },
        screenshot: { jpeg: "", width: 674, height: 408 },
      }),
      true,
    );
    expect(footer).toContain("Focused: 6 text");
    expect(footer).toContain("Selected text: 40");
    expect(footer).toContain("Menu bar: Calculator, Edit");
    expect(footer).toContain("Click coordinates are pixels in this image.");
  });

  it("explain an empty off-screen window instead of showing nothing", () => {
    expect(stateFooter(state([window]), false)).toContain("Observe again");
  });

  it("keep a locked session on accessibility without suggesting foreground recovery", () => {
    const locked = state([window], { screenLocked: true });
    expect(stateHeader(locked)).toContain(
      "The Mac is locked. Use accessibility actions and element ids",
    );
    expect(stateHeader(locked)).toContain("screenshots and activate are unavailable");
    expect(stateFooter(locked, false)).not.toContain("Activating");
  });
});
