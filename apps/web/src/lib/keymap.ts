/**
 * Every shortcut, in one place. Tooltips, menus, the palette and Settings › Keyboard read
 * labels and keys from here; `useHotkey` binds them, with the user's rebindings applied
 * (`lib/keybindings.ts`). Notation: "mod" is ⌘ on Apple platforms and Ctrl elsewhere; a space
 * separates the keys of a sequence ("g h").
 */

/**
 * Where a shortcut works. `global` ones work on every screen; the others only while that
 * context is showing (or focused), so a key may mean one thing in each of them.
 */
export type KeyScope =
  | "global"
  | "thread"
  | "composer"
  | "terminal"
  | "activity"
  | "deck"
  | "notifications";

export interface KeymapEntry {
  /** The default binding, and the spelling call sites pass (`keymap.x.keys`). */
  readonly keys: string;
  readonly label: string;
  /** Used in a browser tab, where the browser keeps `keys` for itself (⌘N, ⌘T, ⌘W). */
  readonly web?: string;
  /** Used off Apple platforms, where `keys` would collide once ⌃ and ⌘ are both Ctrl. */
  readonly nonApple?: string;
  /** Extra bindings that always work alongside the main one (↓ beside j). Not rebindable. */
  readonly also?: readonly string[];
  /** Defaults to `global`. */
  readonly scope?: KeyScope;
  /** Bound by the platform or a library, so it can be shown but not rebound. */
  readonly fixed?: boolean;
}

export const keymap = {
  palette: { keys: "mod+k", label: "Command palette" },
  newThread: { keys: "mod+n", web: "alt+mod+n", label: "New thread" },
  newDeck: { keys: "shift+mod+n", web: "alt+shift+mod+n", label: "New deck" },
  addProject: { keys: "shift+mod+o", label: "Add project" },
  back: { keys: "mod+[", label: "Back" },
  forward: { keys: "mod+]", label: "Forward" },
  toggleSidebar: { keys: "mod+\\", label: "Hide or show the sidebar" },
  // The workspace docks (features/shell/workspace). One map for tooltips, launcher and palette.
  rightPanel: { keys: "shift+mod+b", nonApple: "alt+mod+b", label: "Show or hide the side panel" },
  bottomPanel: { keys: "mod+j", label: "Show or hide the bottom panel" },
  fullView: { keys: "shift+mod+f", label: "Full view" },
  summary: { keys: "alt+mod+o", label: "Pin or unpin the thread summary" },
  newTab: { keys: "alt+mod+t", label: "New tab" },
  closeTab: { keys: "alt+mod+w", label: "Close tab" },
  reopenTab: { keys: "shift+alt+mod+t", label: "Reopen closed tab" },
  nextTab: { keys: "shift+mod+]", label: "Next tab" },
  previousTab: { keys: "shift+mod+[", label: "Previous tab" },
  changes: { keys: "shift+mod+d", label: "Changes" },
  agents: { keys: "ctrl+shift+a", label: "Agents" },
  terminal: { keys: "ctrl+`", label: "Terminal" },
  files: { keys: "mod+p", label: "Open a file" },
  browser: { keys: "ctrl+shift+b", label: "Browser" },
  newTerminal: { keys: "ctrl+shift+`", label: "New terminal" },
  findInTerminal: { keys: "mod+f", label: "Find in a terminal or log", scope: "terminal" },
  sideChat: { keys: "alt+mod+s", label: "Side chat" },
  renameThread: { keys: "alt+mod+r", label: "Rename the thread" },
  pinThread: { keys: "alt+mod+p", label: "Pin or unpin the thread" },
  archiveThread: {
    keys: "shift+mod+a",
    nonApple: "alt+shift+mod+a",
    label: "Archive the thread",
  },
  preview: { keys: "ctrl+shift+p", label: "Preview" },
  devices: { keys: "ctrl+shift+m", label: "Devices" },
  logs: { keys: "ctrl+shift+l", label: "Logs" },
  takeControl: { keys: "ctrl+shift+c", label: "Take or hand back control of a browser or device" },
  // A long thread (features/thread/long): its turns, moving between them, searching it.
  turns: { keys: "alt+mod+g", label: "Turns of this thread" },
  previousTurn: { keys: "alt+mod+arrowup", label: "Previous turn" },
  nextTurn: { keys: "alt+mod+arrowdown", label: "Next turn" },
  findInThread: { keys: "mod+f", label: "Search this thread", scope: "thread" },
  settings: { keys: "mod+,", label: "Settings" },
  send: { keys: "mod+enter", label: "Send", scope: "composer" },
  goHome: { keys: "g h", label: "Go to Home" },
  goActivity: { keys: "g a", label: "Go to Activity" },
  goDeck: { keys: "g d", label: "Go to Deck" },
  goAutomations: { keys: "g u", label: "Go to Automations" },
  goSkills: { keys: "g s", label: "Go to Skills" },
  // Activity triage (features/activity): plain keys, never inside a text field.
  "activity.next": { keys: "j", also: ["arrowdown"], label: "Next item", scope: "activity" },
  "activity.prev": { keys: "k", also: ["arrowup"], label: "Previous item", scope: "activity" },
  "activity.open": { keys: "enter", also: ["o"], label: "Open the item", scope: "activity" },
  "activity.approve": { keys: "a", label: "Approve", scope: "activity" },
  "activity.deny": { keys: "d", label: "Deny", scope: "activity" },
  "activity.read": { keys: "e", label: "Mark read", scope: "activity" },
  "activity.unread": { keys: "u", label: "Mark unread", scope: "activity" },
  // A deck run (features/deck).
  deckPlan: { keys: "g p", label: "Go to the plan", scope: "deck" },
  deckLanes: { keys: "g l", label: "Go to the lanes", scope: "deck" },
  deckApprove: { keys: "mod+enter", label: "Approve the open decision", scope: "deck" },
  deckNextCard: { keys: "j", label: "Next card", scope: "deck" },
  deckPrevCard: { keys: "k", label: "Previous card", scope: "deck" },
  // Base UI's toast viewport binds F6 itself; listed so shortcut help shows it.
  focusToasts: {
    keys: "f6",
    label: "Focus notifications",
    scope: "notifications",
    fixed: true,
  },
} as const satisfies Record<string, KeymapEntry>;

export type KeymapId = keyof typeof keymap;

/** Every id, in keymap order (Settings › Keyboard lists them this way). */
export const keymapIds = Object.keys(keymap) as KeymapId[];

export function isKeymapId(id: string): id is KeymapId {
  return Object.hasOwn(keymap, id);
}

/** An entry with its optional fields visible to TypeScript. */
export function keymapEntry(id: KeymapId): KeymapEntry {
  return keymap[id];
}

const apple = /Mac|iPhone|iPad/.test(globalThis.navigator?.userAgent ?? "Mac");
/** ⌘ is the command key here (Apple platforms); elsewhere "mod" is Ctrl. */
export const applePlatform = apple;

export interface Chord {
  key: string;
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/** "shift+mod+d" → a chord. The final part is the key, so "mod++" and "ctrl+`" parse. */
export function parseChord(text: string): Chord {
  const parts = text.split(/\+(?!$)/).map((part) => part.toLowerCase());
  const key = parts.at(-1) ?? "";
  return {
    key,
    mod: parts.includes("mod"),
    ctrl: parts.includes("ctrl"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
  };
}

const glyphs: Record<string, [apple: string, other: string]> = {
  mod: ["⌘", "Ctrl+"],
  shift: ["⇧", "Shift+"],
  ctrl: ["⌃", "Ctrl+"],
  alt: ["⌥", "Alt+"],
  enter: ["↵", "Enter"],
  escape: ["esc", "Esc"],
  arrowup: ["↑", "↑"],
  arrowdown: ["↓", "↓"],
  arrowleft: ["←", "←"],
  arrowright: ["→", "→"],
};

function formatChord(chord: string, isApple: boolean): string {
  return chord
    .split(/\+(?!$)/)
    .map((part) => {
      const glyph = glyphs[part.toLowerCase()];
      return glyph ? glyph[isApple ? 0 : 1] : part.toUpperCase();
    })
    .join("");
}

/**
 * The chords of a binding, each formatted: "g h" → ["G", "H"], "shift+mod+n" → ["⇧⌘N"].
 * A sequence renders as one chip per chord ("G then H").
 */
export function formatKeyParts(keys: string, isApple = apple): string[] {
  return keys.split(" ").map((chord) => formatChord(chord, isApple));
}

/** "shift+mod+n" → "⇧⌘N" on Apple platforms, "Shift+Ctrl+N" elsewhere; "g h" → "G H". */
export function formatKeys(keys: string, isApple = apple): string {
  return formatKeyParts(keys, isApple).join(" ");
}

/** Spoken form for an accessible name: "g h" → "G then H". */
export function describeKeys(keys: string, isApple = apple): string {
  return formatKeyParts(keys, isApple).join(" then ");
}
