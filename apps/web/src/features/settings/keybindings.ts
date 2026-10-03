import { useMemo } from "react";
import { parseChord } from "@/lib/hotkeys.ts";
import { keymap, type KeymapId } from "@/lib/keymap.ts";
import { settingKeys, type Keybindings } from "./data/setting-keys.ts";
import { useSetting } from "./data/use-settings.ts";

export type ResolvedKeymap = Record<KeymapId, string>;

const keymapIds = Object.keys(keymap) as KeymapId[];
const isKeymapId = (id: string): id is KeymapId => id in keymap;

/** Defaults with the user's rebindings on top. Unknown ids from other versions are ignored. */
export function resolveKeymap(overrides: Keybindings): ResolvedKeymap {
  const resolved: Record<string, string> = Object.fromEntries(
    keymapIds.map((id) => [id, keymap[id].keys]),
  );
  for (const [id, keys] of Object.entries(overrides)) if (isKeymapId(id)) resolved[id] = keys;
  return resolved as ResolvedKeymap;
}

/** One spelling per shortcut, so "mod+shift+d" and "shift+mod+d" compare equal. */
export function normalizeKeys(keys: string): string {
  return keys
    .split(" ")
    .map((text) => {
      const chord = parseChord(text);
      return [
        chord.ctrl && "ctrl",
        chord.alt && "alt",
        chord.shift && "shift",
        chord.mod && "mod",
        chord.key,
      ]
        .filter(Boolean)
        .join("+");
    })
    .join(" ");
}

/** The shortcut that already uses `keys`, other than `except`. */
export function conflictFor(
  keys: string,
  except: KeymapId,
  bindings: ResolvedKeymap,
): KeymapId | undefined {
  const wanted = normalizeKeys(keys);
  return keymapIds.find((id) => id !== except && normalizeKeys(bindings[id]) === wanted);
}

const codeKeys: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Backslash: "\\",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Minus: "-",
  Equal: "=",
  Space: "space",
};

function keyName(event: Pick<KeyboardEvent, "key" | "code">): string {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(event.code)) return event.code.slice(5);
  return codeKeys[event.code] ?? event.key.toLowerCase();
}

export type Recorded =
  | { kind: "chord"; keys: string }
  | { kind: "cancel" }
  | { kind: "incomplete" }
  | { kind: "needs-modifier" };

/**
 * Turn a keydown into keymap notation. ⌘ (or Ctrl off Apple platforms) records as "mod" so the
 * binding works on every platform; function keys may stand alone, other keys need a modifier.
 */
export function recordChord(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  isApple: boolean,
): Recorded {
  if (["Shift", "Meta", "Control", "Alt"].includes(event.key)) return { kind: "incomplete" };
  const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
  if (event.key === "Escape" && plain && !event.shiftKey) return { kind: "cancel" };
  const functionKey = /^F([1-9]|1[0-9])$/.test(event.key);
  if (plain && !functionKey) return { kind: "needs-modifier" };
  const mod = event.metaKey || (!isApple && event.ctrlKey);
  const ctrl = isApple && event.ctrlKey;
  const parts = [
    ctrl && "ctrl",
    event.altKey && "alt",
    event.shiftKey && "shift",
    mod && "mod",
    keyName(event),
  ];
  return { kind: "chord", keys: parts.filter(Boolean).join("+") };
}

/**
 * The keymap with the user's rebindings, stored in the daemon so every client agrees.
 * Shell code binds `useKeymap()[id]` instead of `keymap[id].keys` to honour rebinding.
 */
export function useKeymap(): ResolvedKeymap {
  const [overrides] = useSetting(settingKeys.keybindings);
  return useMemo(() => resolveKeymap(overrides), [overrides]);
}
