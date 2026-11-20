import { expect, test } from "vitest";
import { editorKeys } from "./editor-keys.ts";

const mac = { apple: true, web: false };
const macWeb = { apple: true, web: true };
const pc = { apple: false, web: false };
const press = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

test.each([
  ["⌘S saves", mac, { key: "s", code: "KeyS", metaKey: true }, "save"],
  ["⇧⌘S saves all", mac, { key: "s", code: "KeyS", metaKey: true, shiftKey: true }, "saveAll"],
  ["⌥⌘S saves all", mac, { key: "ß", code: "KeyS", metaKey: true, altKey: true }, "saveAll"],
  ["⌘W closes the editor in the app", mac, { key: "w", code: "KeyW", metaKey: true }, "close"],
  [
    "⌥⌘W closes it in a browser",
    macWeb,
    { key: "w", code: "KeyW", metaKey: true, altKey: true },
    "close",
  ],
  ["⇧⌘T reopens", mac, { key: "t", code: "KeyT", metaKey: true, shiftKey: true }, "reopen"],
  [
    "⌥⌘\\ splits right",
    mac,
    { key: "\\", code: "Backslash", metaKey: true, altKey: true },
    "splitRight",
  ],
  ["⌘B toggles the explorer", mac, { key: "b", code: "KeyB", metaKey: true }, "explorer"],
  [
    "⇧⌘F searches files",
    mac,
    { key: "f", code: "KeyF", metaKey: true, shiftKey: true },
    "searchFiles",
  ],
  ["⌃Tab lists recent editors", mac, { key: "Tab", code: "Tab", ctrlKey: true }, "recent"],
  [
    "⌃⇧Tab steps back",
    mac,
    { key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true },
    "recentBack",
  ],
  ["F4 steps to the next hit", mac, { key: "F4", code: "F4" }, "nextHit"],
  ["⇧F4 to the previous", mac, { key: "F4", code: "F4", shiftKey: true }, "previousHit"],
  ["⌥F5 to the next agent change", mac, { key: "F5", code: "F5", altKey: true }, "nextChange"],
  [
    "⌃⌘→ moves the editor on",
    mac,
    { key: "ArrowRight", code: "ArrowRight", metaKey: true, ctrlKey: true },
    "moveEditorOn",
  ],
  [
    "Ctrl+Shift+PageUp moves it back off Apple",
    pc,
    { key: "PageUp", code: "PageUp", ctrlKey: true, shiftKey: true },
    "moveEditorBack",
  ],
  ["Esc goes back to the composer", mac, { key: "Escape", code: "Escape" }, "composer"],
] as const)("%s", (_, env, init, command) => {
  expect(editorKeys(env).press(press(init))).toBe(command);
});

test("keys the editor doesn't own pass through: ⌘1 is the editor's own group focus, ⌘\\ the sidebar", () => {
  const keys = editorKeys(mac);
  expect(keys.press(press({ key: "\\", code: "Backslash", metaKey: true }))).toBeUndefined();
  expect(keys.press(press({ key: "ArrowLeft", code: "ArrowLeft", ctrlKey: true }))).toBeUndefined();
  // Off Apple, Ctrl+← moves by word in the editor; it never moves the editor.
  expect(
    editorKeys(pc).press(press({ key: "ArrowLeft", code: "ArrowLeft", ctrlKey: true })),
  ).toBeUndefined();
});

test("⌘K ⌘W closes all; ⌘K then anything else is not an editor key", () => {
  const keys = editorKeys(mac);
  expect(keys.press(press({ key: "k", code: "KeyK", metaKey: true }))).toBeUndefined();
  expect(keys.waiting()).toBe(true);
  expect(keys.press(press({ key: "w", code: "KeyW", metaKey: true }))).toBe("closeAll");
  expect(keys.waiting()).toBe(false);

  keys.press(press({ key: "k", code: "KeyK", metaKey: true }));
  expect(keys.press(press({ key: "p", code: "KeyP", metaKey: true }))).toBeUndefined();
  expect(keys.waiting()).toBe(false);
  // A plain ⌘W after the wait ended is Close.
  expect(keys.press(press({ key: "w", code: "KeyW", metaKey: true }))).toBe("close");
});
