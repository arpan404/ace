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
  | "home"
  | "thread"
  | "composer"
  | "newThread"
  | "panel"
  | "files"
  | "terminal"
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
  shortcuts: { keys: "mod+/", also: ["shift+/"], label: "Keyboard shortcuts" },
  // One launcher: ⇧⌘K, once a separate search sheet, opens the same palette.
  palette: { keys: "mod+k", also: ["shift+mod+k"], label: "Command palette" },
  newThread: { keys: "mod+n", web: "alt+mod+n", label: "New thread" },
  // In the current project without asking which (⌘N asks when there are several).
  newThreadHere: {
    keys: "shift+mod+n",
    web: "shift+alt+mod+n",
    label: "New thread in the current project",
  },
  addProject: { keys: "shift+mod+o", label: "Add project" },
  nextThread: { keys: "alt+mod+arrowdown", label: "Next thread" },
  previousThread: { keys: "alt+mod+arrowup", label: "Previous thread" },
  nextNeedsYou: { keys: "alt+mod+j", label: "Next thread that needs you" },
  // ⌘1 to ⌘9 open the list's first nine threads; a browser keeps ⌘1–9 for its tabs. Holding
  // the modifiers shows each row's number. Bound as nine keys, so shown but not rebound.
  jumpToThread: {
    keys: "mod+1",
    web: "alt+mod+1",
    label: "Open thread 1 to 9 in the list",
    fixed: true,
  },
  // F6 walks the window's regions: thread list, main view, side panel, composer.
  nextRegion: { keys: "f6", label: "Focus the next region" },
  previousRegion: { keys: "shift+f6", label: "Focus the previous region" },
  focusThreadList: { keys: "shift+mod+e", label: "Focus the thread list" },
  focusComposer: { keys: "mod+l", web: "alt+mod+l", label: "Focus the composer" },
  stopAgent: { keys: "mod+.", label: "Stop the agent", scope: "thread" },
  // The latest archive, settle, snooze, unpin or discard, while its Undo still shows.
  undo: { keys: "mod+z", label: "Undo the last thread action" },
  // Opens the focused item's menu (a row, a tab, a file), as a right-click does.
  contextMenu: { keys: "shift+f10", label: "Open the focused item's menu", fixed: true },
  back: { keys: "mod+[", label: "Back" },
  forward: { keys: "mod+]", label: "Forward" },
  toggleSidebar: { keys: "mod+\\", label: "Hide or show the sidebar" },
  // The side panel (features/shell/workspace). One map for tooltips, launcher and palette.
  rightPanel: { keys: "shift+mod+b", nonApple: "alt+mod+b", label: "Show or hide the side panel" },
  fullView: { keys: "shift+mod+f", label: "Full view" },
  workCard: { keys: "alt+mod+o", label: "Show or hide thread details" },
  newTab: { keys: "alt+mod+t", label: "New tab" },
  closeTab: { keys: "alt+mod+w", label: "Close tab" },
  reopenTab: { keys: "shift+alt+mod+t", label: "Reopen closed tab" },
  nextTab: { keys: "shift+mod+]", label: "Next tab" },
  previousTab: { keys: "shift+mod+[", label: "Previous tab" },
  changes: { keys: "shift+mod+d", label: "Changes" },
  agents: { keys: "ctrl+shift+a", label: "Summary" },
  // Both follow Settings' "Terminals open in": the bottom terminal panel (shown and focused,
  // then hidden) or the side panel's terminal. ⌃` also works from inside a shell off Apple,
  // where Ctrl+J is the shell's.
  terminal: { keys: "ctrl+`", label: "Terminal" },
  terminalPanel: { keys: "mod+j", label: "Show or hide the terminal panel" },
  files: { keys: "mod+p", label: "Open a file" },
  browser: { keys: "ctrl+shift+b", label: "Browser" },
  newTerminal: { keys: "ctrl+shift+`", label: "New terminal" },
  // The terminal owns its find key (keys.ts): ⌘F on a Mac, Ctrl+Shift+F elsewhere (Ctrl+F is
  // the shell's). Shown, not rebindable.
  findInTerminal: {
    keys: "mod+f",
    nonApple: "shift+mod+f",
    label: "Find in a terminal or log",
    scope: "terminal",
    fixed: true,
  },
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
  // A long thread (features/thread/long): its turns, moving between them, searching it.
  turns: { keys: "alt+mod+g", label: "Turns of this thread" },
  previousTurn: { keys: "shift+alt+mod+arrowup", label: "Previous turn" },
  nextTurn: { keys: "shift+alt+mod+arrowdown", label: "Next turn" },
  findInThread: { keys: "mod+f", label: "Search this thread", scope: "thread" },
  settings: { keys: "mod+,", label: "Settings" },
  // A fresh page and a fresh daemon connection, as a browser's reload. A focused browser
  // panel keeps ⌘R for its own page.
  reloadApp: { keys: "mod+r", label: "Reload ace" },
  // Enter sends. While the agent works Enter queues or steers (Settings › Threads); this does
  // the other.
  followUpOther: {
    keys: "mod+enter",
    label: "Queue or steer the other way",
    scope: "composer",
  },
  // New thread: start the thread and stay on New thread, ready for the next one.
  startInBackground: {
    keys: "mod+enter",
    label: "Start a thread without opening it",
    scope: "newThread",
  },
  // The first Esc asks in the strip; a second one soon after stops the agent tree.
  stopFromComposer: {
    keys: "escape escape",
    label: "Stop the working agent",
    scope: "composer",
    fixed: true,
  },
  reorderQueued: {
    keys: "alt+arrowup",
    also: ["alt+arrowdown"],
    label: "Move a queued message up or down",
    scope: "composer",
    fixed: true,
  },
  goHome: { keys: "g h", label: "Go to Home" },
  goAutomations: { keys: "g u", label: "Go to Automations" },
  goSkills: { keys: "g s", label: "Go to Skills" },
  goPullRequests: { keys: "g p", label: "Go to Pull requests" },
  goIssues: { keys: "g i", label: "Go to Issues" },
  // The Home thread list (features/home): plain keys on the focused row.
  "home.pin": { keys: "p", label: "Pin or unpin the focused thread", scope: "home" },
  "home.select": { keys: "x", label: "Select the focused thread", scope: "home" },
  "home.move": {
    keys: "space",
    label: "Move the focused thread (↑ ↓ to choose, Space to drop)",
    scope: "home",
  },
  "home.actions": {
    keys: "arrowright",
    also: ["arrowleft"],
    label: "Into the focused thread's actions, and back",
    scope: "home",
    fixed: true,
  },
  "home.range": {
    keys: "shift+arrowdown",
    also: ["shift+arrowup"],
    label: "Select a range of threads",
    scope: "home",
    fixed: true,
  },
  "home.ends": {
    keys: "home",
    also: ["end"],
    label: "First or last thread (or type a title to jump to it)",
    scope: "home",
    fixed: true,
  },
  // The side panel's tab strip, on a focused tab.
  "panel.closeTab": { keys: "delete", label: "Close the focused tab", scope: "panel", fixed: true },
  "panel.moveTab": {
    keys: "alt+shift+arrowleft",
    also: ["alt+shift+arrowright"],
    label: "Move the focused tab",
    scope: "panel",
    fixed: true,
  },
  // The file tree, on a focused file.
  "files.rename": { keys: "f2", label: "Rename the focused file", scope: "files", fixed: true },
  "files.delete": { keys: "delete", label: "Delete the focused file", scope: "files", fixed: true },
  "files.move": {
    keys: "shift+mod+m",
    label: "Move the focused file",
    scope: "files",
    fixed: true,
  },
  // Base UI's toast viewport answers F6 itself; F6 walks regions now (`nextRegion`), so this
  // hands Base UI its F6 under another key (features/shell/regions).
  focusToasts: { keys: "alt+f6", label: "Focus notifications" },
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
  backspace: ["⌫", "Backspace"],
  delete: ["⌦", "Delete"],
  home: ["Home", "Home"],
  end: ["End", "End"],
  space: ["Space", "Space"],
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
/** The keys in one chord as individual platform labels, without joining punctuation. */
export function formatChordParts(keys: string, isApple = apple): string[] {
  return keys.split(/\+(?!$)/).map((part) => {
    const glyph = glyphs[part.toLowerCase()];
    return glyph ? glyph[isApple ? 0 : 1].replace(/\+$/, "") : part.toUpperCase();
  });
}

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
