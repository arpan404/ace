import { expect, test } from "vitest";
import { matchesChord } from "./hotkeys.ts";
import { recordChord } from "./keybindings.ts";
import { parseChord } from "./keymap.ts";

/** A key press as a browser reports it. */
const press = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

test.each([
  ["⌘Space", { key: " ", code: "Space", metaKey: true }, true],
  ["Ctrl+Space", { key: " ", code: "Space", ctrlKey: true }, false],
  ["Ctrl+Shift+1 (types !)", { key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }, false],
  ["⌥⌘2 (types ™)", { key: "™", code: "Digit2", metaKey: true, altKey: true }, true],
] as const)("a binding recorded as %s fires on the same press", (_name, init, apple) => {
  const recorded = recordChord(press(init), apple);
  expect(recorded.kind).toBe("chord");
  if (recorded.kind !== "chord") return;
  expect(matchesChord(press(init), parseChord(recorded.keys), apple)).toBe(true);
});
