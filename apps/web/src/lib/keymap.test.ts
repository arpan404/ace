import { expect, test } from "vitest";
import { matchesChord } from "./hotkeys.ts";
import {
  bindingsFor,
  normalizeKeys,
  resolveKeymap,
  scopeOf,
  scopesOverlap,
  type KeyboardEnv,
} from "./keybindings.ts";
import { keymapIds, parseChord, type KeymapId } from "./keymap.ts";

const platforms: [string, KeyboardEnv][] = [
  ["macOS app", { apple: true, web: false }],
  ["macOS browser", { apple: true, web: true }],
  ["Windows/Linux app", { apple: false, web: false }],
  ["Windows/Linux browser", { apple: false, web: true }],
];

test.each(platforms)("no two shortcuts that can be live together share keys (%s)", (_, env) => {
  const resolved = resolveKeymap({}, env);
  const owners = new Map<string, KeymapId[]>();
  for (const id of keymapIds)
    for (const keys of bindingsFor(id, resolved, {}, env)) {
      const chord = normalizeKeys(keys, env);
      owners.set(chord, [...(owners.get(chord) ?? []), id]);
    }
  const clashes = [...owners.entries()].flatMap(([chord, ids]) =>
    ids.flatMap((a, index) =>
      ids
        .slice(index + 1)
        .filter((b) => scopesOverlap(scopeOf(a), scopeOf(b)))
        .map((b) => `${chord}: ${a} / ${b}`),
    ),
  );
  expect(clashes).toEqual([]);
});

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

test("in a browser tab New thread moves off ⌘N, which the browser keeps; the desktop app keeps ⌘N", () => {
  expect(resolveKeymap({}, { apple: true, web: true }).newThread).toBe("alt+mod+n");
  expect(resolveKeymap({}, { apple: true, web: false }).newThread).toBe("mod+n");
  // A rebinding wins everywhere.
  expect(resolveKeymap({ newThread: "alt+mod+j" }, { apple: true, web: true }).newThread).toBe(
    "alt+mod+j",
  );
});

test("rebindings of unknown or fixed shortcuts are ignored", () => {
  const resolved = resolveKeymap(
    { focusToasts: "mod+y", "not.a.shortcut": "mod+u", palette: "shift+mod+y" },
    { apple: true, web: false },
  );
  expect(resolved.focusToasts).toBe("f6");
  expect(resolved.palette).toBe("shift+mod+y");
});
