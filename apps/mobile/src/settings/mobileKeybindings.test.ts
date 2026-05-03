import { describe, expect, it } from "vitest";
import type { ResolvedKeybindingsConfig } from "@ace/contracts";
import {
  encodeShortcutValue,
  filterMobileKeybindings,
  findMobileKeybindingConflicts,
  formatShortcutValue,
  keybindingCommandLabel,
  keybindingWhenExpression,
} from "./mobileKeybindings";

const baseShortcut = {
  key: "k",
  modKey: true,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
};

function makeBindings(): ResolvedKeybindingsConfig {
  return [
    {
      command: "chat.new",
      shortcut: baseShortcut,
    },
    {
      command: "rightPanel.browser.open",
      shortcut: {
        key: "b",
        modKey: true,
        ctrlKey: false,
        metaKey: false,
        altKey: true,
        shiftKey: false,
      },
      whenAst: {
        type: "and",
        left: { type: "identifier", name: "threadOpen" },
        right: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
      },
    },
    {
      command: "chat.newLocal",
      shortcut: baseShortcut,
    },
  ];
}

describe("mobile keybinding helpers", () => {
  it("formats commands and shortcuts for mobile settings rows", () => {
    expect(keybindingCommandLabel("browser.open-current-url")).toBe("Browser Open Current Url");
    expect(encodeShortcutValue(baseShortcut)).toBe("mod+k");
    expect(formatShortcutValue(baseShortcut)).toBe("Cmd/Ctrl + K");
  });

  it("serializes nested when expressions", () => {
    expect(keybindingWhenExpression(makeBindings()[1]?.whenAst)).toBe(
      "threadOpen && !terminalFocus",
    );
  });

  it("filters by command, formatted shortcut, and when expression", () => {
    const bindings = makeBindings();

    expect(filterMobileKeybindings(bindings, "browser")).toHaveLength(1);
    expect(filterMobileKeybindings(bindings, "alt+b")).toHaveLength(1);
    expect(filterMobileKeybindings(bindings, "terminalFocus")).toHaveLength(1);
    expect(filterMobileKeybindings(bindings, "missing")).toHaveLength(0);
  });

  it("reports duplicate shortcuts with the same condition", () => {
    expect(findMobileKeybindingConflicts(makeBindings())).toEqual([
      {
        shortcut: "mod+k",
        commands: ["chat.new", "chat.newLocal"],
        when: undefined,
      },
    ]);
  });
});
