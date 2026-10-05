import { expect, test } from "vitest";
import { matchesChord } from "./hotkeys.ts";
import {
  bindingsFor,
  conflictFor,
  normalizeKeys,
  recordChord,
  resolveKeymap,
  type KeyboardEnv,
} from "./keybindings.ts";
import { keymapIds, parseChord, type KeymapId } from "./keymap.ts";

const platforms: [string, KeyboardEnv][] = [
  ["macOS app", { apple: true, web: false }],
  ["macOS browser", { apple: true, web: true }],
  ["Windows/Linux app", { apple: false, web: false }],
  ["Windows/Linux browser", { apple: false, web: true }],
];

/**
 * Pairs that may share keys because they are never live at once, each with why. Written out
 * here rather than read from the keymap's scopes, so the scopes can't vouch for themselves.
 */
const sharing: [KeymapId, KeymapId, string][] = [
  ["findInThread", "findInTerminal", "the terminal takes ⌘F only while it has focus"],
  ["fullView", "findInTerminal", "off Apple the terminal takes Ctrl+Shift+F while focused"],
  ["send", "deckApprove", "the composer's ⌘↵ and a deck page's are never on screen together"],
  ["activity.next", "deckNextCard", "Activity's j and a deck's j are different pages"],
  ["activity.prev", "deckPrevCard", "Activity's k and a deck's k are different pages"],
];
const allowed = (a: KeymapId, b: KeymapId) =>
  sharing.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

test.each(platforms)(
  "no two shortcuts share keys unless listed as never live together (%s)",
  (_, env) => {
    const resolved = resolveKeymap({}, env);
    const owners = new Map<string, KeymapId[]>();
    for (const id of keymapIds)
      for (const keys of bindingsFor(id, resolved, env)) {
        const chord = normalizeKeys(keys, env);
        owners.set(chord, [...(owners.get(chord) ?? []), id]);
      }
    const clashes = [...owners.entries()].flatMap(([chord, ids]) =>
      ids.flatMap((a, index) =>
        ids
          .slice(index + 1)
          .filter((b) => !allowed(a, b))
          .map((b) => `${chord}: ${a} / ${b}`),
      ),
    );
    expect(clashes).toEqual([]);
  },
);

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

test("on a Mac ⌃⇧B is the Browser and ⇧⌘B the side panel; elsewhere Ctrl+Shift+B is only the Browser", () => {
  const ctrlShiftB = key({ key: "B", code: "KeyB", ctrlKey: true, shiftKey: true });
  const cmdShiftB = key({ key: "B", code: "KeyB", metaKey: true, shiftKey: true });

  const mac = resolveKeymap({}, { apple: true, web: false });
  expect(matchesChord(ctrlShiftB, parseChord(mac.browser), true)).toBe(true);
  expect(matchesChord(ctrlShiftB, parseChord(mac.rightPanel), true)).toBe(false);
  expect(matchesChord(cmdShiftB, parseChord(mac.rightPanel), true)).toBe(true);

  const pc = resolveKeymap({}, { apple: false, web: false });
  expect(matchesChord(ctrlShiftB, parseChord(pc.browser), false)).toBe(true);
  expect(matchesChord(ctrlShiftB, parseChord(pc.rightPanel), false)).toBe(false);
  const ctrlAltB = key({ key: "b", code: "KeyB", ctrlKey: true, altKey: true });
  expect(matchesChord(ctrlAltB, parseChord(pc.rightPanel), false)).toBe(true);
});

test.each([
  ["⌃⌘Y on a Mac", { key: "y", code: "KeyY", metaKey: true, ctrlKey: true }, true],
  ["Ctrl+Space", { key: " ", code: "Space", ctrlKey: true }, false],
  ["Ctrl+Shift+/", { key: "?", code: "Slash", ctrlKey: true, shiftKey: true }, false],
  ["⌥⌘P on a Mac", { key: "π", code: "KeyP", metaKey: true, altKey: true }, true],
] as const)("whatever the recorder saves for %s, the same keys press it", (_, init, apple) => {
  const press = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init };
  const recorded = recordChord(press, apple);
  if (recorded.kind !== "chord") throw new Error(`not recorded: ${recorded.kind}`);
  expect(matchesChord(key(press), parseChord(recorded.keys), apple)).toBe(true);
});

test("on a Mac modifiers match exactly: ⌃⌘K is not ⌘K, and ⌘K is not ⌃⌘K", () => {
  const cmdK = key({ key: "k", code: "KeyK", metaKey: true });
  const ctrlCmdK = key({ key: "k", code: "KeyK", metaKey: true, ctrlKey: true });
  expect(matchesChord(ctrlCmdK, parseChord("mod+k"), true)).toBe(false);
  expect(matchesChord(cmdK, parseChord("ctrl+mod+k"), true)).toBe(false);
  expect(matchesChord(ctrlCmdK, parseChord("ctrl+mod+k"), true)).toBe(true);
});

test("in a browser tab New thread moves off ⌘N, which the browser keeps; the desktop app keeps ⌘N", () => {
  expect(resolveKeymap({}, { apple: true, web: true }).newThread).toBe("alt+mod+n");
  expect(resolveKeymap({}, { apple: true, web: false }).newThread).toBe("mod+n");
  // A rebinding wins everywhere.
  expect(resolveKeymap({ newThread: "alt+mod+j" }, { apple: true, web: true }).newThread).toBe(
    "alt+mod+j",
  );
});

test("a key a shortcut still answers through its browser alias can't be given to another", () => {
  const web: KeyboardEnv = { apple: true, web: true };
  const resolved = resolveKeymap({}, web);
  // New deck shows ⌥⇧⌘N in a browser but still answers ⇧⌘N where the browser lets it through.
  expect(conflictFor("shift+mod+n", "newThread", resolved, web)).toBe("newDeck");
  // Once New deck is rebound, its alias is gone and the keys are free.
  const moved = resolveKeymap({ newDeck: "alt+mod+d" }, web);
  expect(conflictFor("shift+mod+n", "newThread", moved, web)).toBeUndefined();
});

test("rebindings of unknown or fixed shortcuts are ignored", () => {
  const resolved = resolveKeymap(
    { focusToasts: "mod+y", send: "mod+u", "not.a.shortcut": "mod+u", palette: "shift+mod+y" },
    { apple: true, web: false },
  );
  expect(resolved.focusToasts).toBe("f6");
  expect(resolved.send).toBe("mod+enter");
  expect(resolved.palette).toBe("shift+mod+y");
});
