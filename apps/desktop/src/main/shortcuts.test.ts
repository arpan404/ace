import { describe, expect, it } from "vitest";
import { appChord, replayChord, type KeyInput } from "./shortcuts.ts";

/** A key press inside an embedded browser page, as Electron's `before-input-event` reports it. */
function press(key: string, code: string, held: Partial<KeyInput> = {}): KeyInput {
  return {
    type: "keyDown",
    key,
    code,
    shift: false,
    control: false,
    alt: false,
    meta: false,
    ...held,
  };
}

/** What the app window receives when the press is forwarded; empty when the page keeps it. */
function forwarded(input: KeyInput, platform: NodeJS.Platform) {
  const sent: unknown[] = [];
  const chord = appChord(input, platform);
  if (chord) replayChord({ sendInputEvent: (event) => void sent.push(event) }, chord, platform);
  return sent;
}

describe("app shortcuts while an embedded page has focus", () => {
  it("forwards the palette, new thread, sidebar and close tab to the app window on macOS", () => {
    expect(forwarded(press("k", "KeyK", { meta: true }), "darwin")).toEqual([
      { type: "keyDown", keyCode: "K", modifiers: ["meta"] },
      { type: "keyUp", keyCode: "K", modifiers: ["meta"] },
    ]);
    expect(forwarded(press("n", "KeyN", { meta: true }), "darwin")).toHaveLength(2);
    expect(forwarded(press("\\", "Backslash", { meta: true }), "darwin")).toHaveLength(2);
    // ⌥ changes the character (⌥W types ∑), not the key.
    expect(forwarded(press("∑", "KeyW", { meta: true, alt: true }), "darwin")).toEqual([
      { type: "keyDown", keyCode: "W", modifiers: ["meta", "alt"] },
      { type: "keyUp", keyCode: "W", modifiers: ["meta", "alt"] },
    ]);
    expect(forwarded(press("A", "KeyA", { control: true, shift: true }), "darwin")).toEqual([
      { type: "keyDown", keyCode: "A", modifiers: ["control", "shift"] },
      { type: "keyUp", keyCode: "A", modifiers: ["control", "shift"] },
    ]);
  });

  it("uses Ctrl where the app does on Windows and Linux", () => {
    expect(forwarded(press("k", "KeyK", { control: true }), "linux")).toEqual([
      { type: "keyDown", keyCode: "K", modifiers: ["control"] },
      { type: "keyUp", keyCode: "K", modifiers: ["control"] },
    ]);
    expect(forwarded(press("k", "KeyK", { meta: true }), "linux")).toEqual([]);
    expect(forwarded(press("k", "KeyK", { control: true }), "darwin")).toEqual([]);
  });

  it("leaves typing and the page's own shortcuts to the page", () => {
    for (const input of [
      press("k", "KeyK"),
      press("K", "KeyK", { shift: true }),
      press("Enter", "Enter", { meta: true }),
      press("l", "KeyL", { meta: true }),
      press("r", "KeyR", { meta: true }),
      press("[", "BracketLeft", { meta: true }),
      press("]", "BracketRight", { meta: true }),
      press("f", "KeyF", { meta: true }),
      // ⌘⇧K is not an app shortcut.
      press("K", "KeyK", { meta: true, shift: true }),
    ])
      expect(forwarded(input, "darwin"), `${input.code}`).toEqual([]);
  });

  it("follows the layout's letters rather than the physical key", () => {
    // AZERTY: the key in QWERTY's Q position types "a".
    expect(appChord(press("a", "KeyQ", { control: true, shift: true }), "darwin")).toBe(
      "Ctrl+Shift+A",
    );
  });
});
