import { useEffect, useMemo, useSyncExternalStore } from "react";
import { hasDesktopBridge } from "@/boot/desktop.ts";
import { useDaemonSetting } from "./daemon-setting.ts";
import {
  applePlatform,
  isKeymapId,
  keymap,
  keymapEntry,
  keymapIds,
  parseChord,
  type KeymapId,
  type KeyScope,
} from "./keymap.ts";

/*
 * Shortcut resolution: the keymap's defaults for this platform with the user's rebindings on
 * top. Rebindings live in the daemon's `clients.keybindings` setting (so every client agrees);
 * `useKeybindingsSync()` feeds them into a small store here, so Kbd, Tip, MenuItem and
 * `useHotkey` read them without a client of their own.
 */

/** Keymap id → keys in keymap notation. Only rebound shortcuts are stored. */
export type Keybindings = Readonly<Record<string, string>>;
export type ResolvedKeymap = Readonly<Record<KeymapId, string>>;

/** Where the app runs, as far as shortcuts care. */
export interface KeyboardEnv {
  /** ⌘ and ⌃ are separate keys (macOS, iOS). */
  apple: boolean;
  /** A browser tab, which keeps ⌘N, ⌘T and ⌘W for itself. False in the desktop app or a PWA. */
  web: boolean;
}

function detectEnv(): KeyboardEnv {
  const standalone =
    typeof globalThis.matchMedia === "function" &&
    globalThis.matchMedia("(display-mode: standalone)").matches;
  return { apple: applePlatform, web: !hasDesktopBridge() && !standalone };
}

let envOverride: KeyboardEnv | undefined;
let detected: KeyboardEnv | undefined;

/** The platform shortcuts resolve for. Detected once. */
export function keyboardEnv(): KeyboardEnv {
  return envOverride ?? (detected ??= detectEnv());
}

/** Tests: pretend to be another platform. `undefined` restores detection. */
export function overrideKeyboardEnv(env: KeyboardEnv | undefined): void {
  envOverride = env;
  resolvedCache = undefined;
  emit();
}

/** The shipped binding of `id` on this platform. */
export function defaultKeys(id: KeymapId, env: KeyboardEnv = keyboardEnv()): string {
  const entry = keymapEntry(id);
  if (env.web && entry.web) return entry.web;
  if (!env.apple && entry.nonApple) return entry.nonApple;
  return entry.keys;
}

/** Whether Settings may rebind `id` (not one a library or the platform binds). */
export function isRebindable(id: KeymapId): boolean {
  return keymapEntry(id).fixed !== true;
}

export function scopeOf(id: KeymapId): KeyScope {
  return keymapEntry(id).scope ?? "global";
}

/** Only well-formed rebindings of ids this build knows. */
function cleanOverrides(raw: unknown): Keybindings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const clean: Record<string, string> = {};
  for (const [id, keys] of Object.entries(raw)) {
    if (!isKeymapId(id) || !isRebindable(id)) continue;
    if (typeof keys === "string" && keys.length > 0 && keys.length <= 64) clean[id] = keys;
  }
  return clean;
}

/** Defaults for this platform with the user's rebindings on top. Unknown ids are ignored. */
export function resolveKeymap(
  overrides: Keybindings,
  env: KeyboardEnv = keyboardEnv(),
): ResolvedKeymap {
  const clean = cleanOverrides(overrides);
  const resolved = {} as Record<KeymapId, string>;
  for (const id of keymapIds) resolved[id] = clean[id] ?? defaultKeys(id, env);
  return resolved;
}

/**
 * One spelling per shortcut, so "mod+shift+d" and "shift+mod+d" compare equal. Off Apple
 * platforms ⌃ and "mod" are the same key, so "ctrl" spells as "mod" there.
 */
export function normalizeKeys(keys: string, env: KeyboardEnv = keyboardEnv()): string {
  return keys
    .split(" ")
    .map((text) => {
      const chord = parseChord(text);
      const mod = chord.mod || (!env.apple && chord.ctrl);
      const ctrl = env.apple && chord.ctrl;
      return [ctrl && "ctrl", chord.alt && "alt", chord.shift && "shift", mod && "mod", chord.key]
        .filter(Boolean)
        .join("+");
    })
    .join(" ");
}

/** Two scopes can be live at once: either is global, or they're the same context. */
export function scopesOverlap(a: KeyScope, b: KeyScope): boolean {
  return a === "global" || b === "global" || a === b;
}

/** The shortcut that already uses `keys` where `except` works, other than `except`. */
export function conflictFor(
  keys: string,
  except: KeymapId,
  bindings: ResolvedKeymap,
  env: KeyboardEnv = keyboardEnv(),
): KeymapId | undefined {
  const wanted = normalizeKeys(keys, env);
  const scope = scopeOf(except);
  return keymapIds.find(
    (id) =>
      id !== except &&
      scopesOverlap(scope, scopeOf(id)) &&
      [bindings[id], ...(keymapEntry(id).also ?? [])].some(
        (bound) => normalizeKeys(bound, env) === wanted,
      ),
  );
}

/**
 * Every binding `useHotkey` listens for: the resolved one, the fixed extras, and in a browser
 * tab the desktop default too (harmless where the browser keeps it, handy where it doesn't).
 */
export function bindingsFor(
  id: KeymapId,
  resolved: ResolvedKeymap,
  overrides: Keybindings = {},
  env: KeyboardEnv = keyboardEnv(),
): string[] {
  const entry = keymapEntry(id);
  const list = [resolved[id], ...(entry.also ?? [])];
  if (env.web && entry.web && !(id in overrides)) list.push(entry.keys);
  return [...new Set(list)];
}

/*
 * Call sites pass `keymap.x.keys`; this maps a default spelling back to its id so a rebinding
 * reaches them unchanged. Defaults two ids share ("mod+f": search a thread, find in a
 * terminal) are ambiguous: those call sites pass the id instead.
 */
const byDefault = new Map<string, KeymapId | null>();
for (const id of keymapIds) {
  const keys = keymap[id].keys;
  byDefault.set(keys, byDefault.has(keys) ? null : id);
}

/** The id whose default spelling is `keys`, unless two ids share it. */
export function keymapIdFor(keys: string): KeymapId | undefined {
  return byDefault.get(keys) ?? undefined;
}

/** What to show or bind for `keys` written as a default (`keymap.x.keys`) or a literal. */
export function resolveKeys(keys: string, resolved: ResolvedKeymap): string {
  const id = keymapIdFor(keys);
  return id ? resolved[id] : keys;
}

// The overrides store.

let overrides: Keybindings = {};
let resolvedCache: ResolvedKeymap | undefined;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getOverrides = () => overrides;
const getResolved = () => (resolvedCache ??= resolveKeymap(overrides));

/** Replace the user's rebindings (from the daemon setting, or a test). */
export function setKeybindingOverrides(next: Keybindings): void {
  const clean = cleanOverrides(next);
  if (JSON.stringify(clean) === JSON.stringify(overrides)) return;
  overrides = clean;
  resolvedCache = undefined;
  emit();
}

/** The user's rebindings as stored (only ids this build knows). */
export function useKeybindingOverrides(): Keybindings {
  return useSyncExternalStore(subscribe, getOverrides, getOverrides);
}

/** The whole keymap as it is bound now: defaults for this platform plus rebindings. */
export function useResolvedKeymap(): ResolvedKeymap {
  return useSyncExternalStore(subscribe, getResolved, getResolved);
}

/** The keys `id` is bound to now, in keymap notation. */
export function useKeys(id: KeymapId): string {
  return useResolvedKeymap()[id];
}

/**
 * `keys` as the user has them: a default spelling (`keymap.x.keys`) resolves through its id;
 * literal keys pass through. Undefined stays undefined.
 */
export function useResolvedKeys(keys: string | undefined): string | undefined {
  const resolved = useResolvedKeymap();
  return keys === undefined ? undefined : resolveKeys(keys, resolved);
}

/** What `useHotkey` listens for: by id when given, else by the reverse map, else literal. */
export function useHotkeyBindings(keys: string, id?: KeymapId): readonly string[] {
  const resolved = useResolvedKeymap();
  const stored = useKeybindingOverrides();
  const target = id ?? keymapIdFor(keys);
  const list = target ? bindingsFor(target, resolved, stored) : [keys];
  const signature = list.join("\n");
  // A stable array per distinct binding set, so listeners re-register only on a real change.
  return useMemo(() => signature.split("\n"), [signature]);
}

/**
 * Keeps the store in step with the daemon's `clients.keybindings`. Mount once, inside the
 * client provider (the shell's GlobalHotkeys does).
 */
export function useKeybindingsSync(): void {
  const [stored] = useDaemonSetting("clients.keybindings");
  useEffect(() => {
    if (stored !== undefined) setKeybindingOverrides(cleanOverrides(stored));
  }, [stored]);
  // Another daemon (or none) may have other rebindings: drop these when the shell goes.
  useEffect(() => () => setKeybindingOverrides({}), []);
}

// Recording a new binding (Settings › Keyboard).

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
