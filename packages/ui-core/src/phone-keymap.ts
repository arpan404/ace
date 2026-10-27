import { keyChord } from "./key-chord.ts";

/*
 * The phone and tablet apps' hardware-keyboard shortcuts, in one table: the app binds them,
 * the iPad menu lists them and Settings › Keyboard shows and rebinds them. Ids match the web
 * keymap's where the action is the same; keys use its notation ("mod" is ⌘, "ctrl" is ⌃).
 * Rebindings are kept per device. Pure.
 */

/** Where a shortcut works: `global` everywhere, the others only while that context shows. */
export type PhoneKeyScope = "global" | "composer" | "sheet";

export interface PhoneKeymapEntry {
  readonly id: string;
  readonly label: string;
  readonly keys: string;
  readonly scope: PhoneKeyScope;
  readonly group: string;
  /** Bound by the system (Esc is a sheet's cancel action): shown, never rebound. */
  readonly fixed?: boolean;
}

export const phoneKeymap: readonly PhoneKeymapEntry[] = [
  { id: "newThread", label: "New thread", keys: "mod+n", scope: "global", group: "Threads" },
  {
    id: "searchThreads",
    label: "Search threads",
    keys: "mod+f",
    scope: "global",
    group: "Threads",
  },
  { id: "nextThread", label: "Next thread", keys: "mod+]", scope: "global", group: "Threads" },
  {
    id: "previousThread",
    label: "Previous thread",
    keys: "mod+[",
    scope: "global",
    group: "Threads",
  },
  {
    id: "toggleSidebar",
    label: "Show or hide the sidebar",
    keys: "ctrl+mod+s",
    scope: "global",
    group: "Window",
  },
  { id: "close", label: "Close", keys: "escape", scope: "sheet", group: "Window", fixed: true },
  { id: "send", label: "Send message", keys: "mod+enter", scope: "composer", group: "Composer" },
];

/** Keys the system or text editing keeps: never offered to a shortcut. */
export const phoneReservedKeys: readonly string[] = [
  "mod+a",
  "mod+c",
  "mod+v",
  "mod+x",
  "mod+z",
  "shift+mod+z",
  "mod+h",
  "mod+space",
  "mod+tab",
  "shift+mod+tab",
  "ctrl+space",
];

/** Keys a shortcut may end on besides letters, digits and punctuation. */
export const phoneNamedKeys = [
  "enter",
  "escape",
  "tab",
  "space",
  "backspace",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
] as const;
const punctuation = "[]\\;',./`-=";
const modifierOrder = ["ctrl", "alt", "shift", "mod"] as const;

/**
 * One spelling per shortcut ("shift+mod+k" for "mod+Shift+K"), or undefined when it is not a
 * shortcut a phone can bind: one key, known modifiers, and ⌘ or ⌃ among them so it never
 * captures typing.
 */
export function normalizePhoneKeys(keys: string): string | undefined {
  const parts = keys
    .toLowerCase()
    .split(/\+(?!$)/)
    .filter(Boolean);
  const key = parts.pop();
  if (!key) return undefined;
  const single = key.length === 1 && (/[a-z0-9]/.test(key) || punctuation.includes(key));
  if (!single && !(phoneNamedKeys as readonly string[]).includes(key)) return undefined;
  if (parts.some((part) => !(modifierOrder as readonly string[]).includes(part))) return undefined;
  const modifiers = modifierOrder.filter((modifier) => parts.includes(modifier));
  if (!modifiers.includes("mod") && !modifiers.includes("ctrl")) return undefined;
  return [...modifiers, key].join("+");
}

/** A phone shortcut as people read it on Apple keyboards: "⌃⌘S", "⌘Return", "Esc". */
export function formatPhoneKeys(keys: string): string {
  const parts = keys.split(/\+(?!$)/);
  const key = parts.pop() ?? "";
  const names: Record<string, string> = { ctrl: "control", alt: "option", mod: "command" };
  return keyChord(
    key,
    parts.map((part) => names[part] ?? part),
  );
}

export type PhoneKeyBindings = Readonly<Record<string, string>>;

/** Defaults with this device's rebindings on top. Unknown, fixed or malformed ones are dropped. */
export function resolvePhoneKeymap(overrides: unknown): PhoneKeyBindings {
  const saved = typeof overrides === "object" && overrides !== null ? overrides : {};
  const resolved: Record<string, string> = {};
  for (const entry of phoneKeymap) {
    const raw: unknown = Reflect.get(saved, entry.id);
    const keys = !entry.fixed && typeof raw === "string" ? normalizePhoneKeys(raw) : undefined;
    resolved[entry.id] = keys ?? entry.keys;
  }
  return resolved;
}

function scopesOverlap(a: PhoneKeyScope, b: PhoneKeyScope): boolean {
  return a === "global" || b === "global" || a === b;
}

export type PhoneKeyProblem =
  | { kind: "invalid" }
  | { kind: "reserved" }
  | { kind: "taken"; by: string; label: string };

/**
 * Why `keys` can't be bound to `id` given the current bindings, or undefined when it can: not a
 * phone shortcut, kept by the system, or already another shortcut's where both work.
 */
export function phoneKeyProblem(
  keys: string,
  id: string,
  bindings: PhoneKeyBindings,
): PhoneKeyProblem | undefined {
  const wanted = normalizePhoneKeys(keys);
  if (!wanted) return { kind: "invalid" };
  if (phoneReservedKeys.includes(wanted)) return { kind: "reserved" };
  const scope = phoneKeymap.find((entry) => entry.id === id)?.scope ?? "global";
  const other = phoneKeymap.find(
    (entry) =>
      entry.id !== id &&
      scopesOverlap(scope, entry.scope) &&
      normalizePhoneKeys(bindings[entry.id] ?? entry.keys) === wanted,
  );
  return other ? { kind: "taken", by: other.id, label: other.label } : undefined;
}
