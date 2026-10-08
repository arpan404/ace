import type { WebContents } from "electron";

/**
 * An app shortcut: the web keymap entry it mirrors (`apps/web/src/lib/keymap.ts`, which owns
 * the behaviour) and its Electron accelerator. `menu.test.ts` checks every entry against the
 * real keymap, so the two cannot drift apart.
 */
export interface Shortcut {
  keymapId: string;
  accelerator: string;
  /** The native menu item's label; absent for chords that are not menu items. */
  label?: string;
  /** An embedded browser page keeps this chord for itself (its own Back, Forward and Find). */
  pageOwned?: true;
}

export const shortcuts: readonly Shortcut[] = [
  { keymapId: "newThread", label: "New Thread", accelerator: "CmdOrCtrl+N" },
  { keymapId: "addProject", label: "Add Project…", accelerator: "CmdOrCtrl+Shift+O" },
  { keymapId: "palette", label: "Command Palette…", accelerator: "CmdOrCtrl+K" },
  { keymapId: "search", label: "Search…", accelerator: "CmdOrCtrl+Shift+K" },
  { keymapId: "findInThread", label: "Find", accelerator: "CmdOrCtrl+F", pageOwned: true },
  { keymapId: "back", label: "Back", accelerator: "CmdOrCtrl+[", pageOwned: true },
  { keymapId: "forward", label: "Forward", accelerator: "CmdOrCtrl+]", pageOwned: true },
  { keymapId: "toggleSidebar", label: "Toggle Sidebar", accelerator: "CmdOrCtrl+\\" },
  { keymapId: "rightPanel", label: "Side Panel", accelerator: "CmdOrCtrl+Shift+B" },
  { keymapId: "fullView", label: "Full View", accelerator: "CmdOrCtrl+Shift+F" },
  { keymapId: "agents", label: "Agents", accelerator: "Ctrl+Shift+A" },
  { keymapId: "changes", label: "Changes", accelerator: "CmdOrCtrl+Shift+D" },
  { keymapId: "terminal", label: "Terminal", accelerator: "Ctrl+`" },
  { keymapId: "settings", label: "Settings…", accelerator: "CmdOrCtrl+," },
  // Not menu items: the app still answers them while an embedded browser page has focus.
  { keymapId: "newTab", accelerator: "CmdOrCtrl+Alt+T" },
  { keymapId: "closeTab", accelerator: "CmdOrCtrl+Alt+W" },
  { keymapId: "nextTab", accelerator: "CmdOrCtrl+Shift+]" },
  { keymapId: "previousTab", accelerator: "CmdOrCtrl+Shift+[" },
  { keymapId: "workCard", accelerator: "CmdOrCtrl+Alt+O" },
  { keymapId: "sideChat", accelerator: "CmdOrCtrl+Alt+S" },
  { keymapId: "turns", accelerator: "CmdOrCtrl+Alt+G" },
  { keymapId: "files", accelerator: "CmdOrCtrl+P" },
  { keymapId: "browser", accelerator: "Ctrl+Shift+B" },
  { keymapId: "preview", accelerator: "Ctrl+Shift+P" },
  { keymapId: "devices", accelerator: "Ctrl+Shift+M" },
  { keymapId: "logs", accelerator: "Ctrl+Shift+L" },
  { keymapId: "takeControl", accelerator: "Ctrl+Shift+C" },
  { keymapId: "newTerminal", accelerator: "Ctrl+Shift+`" },
];

type Modifier = "meta" | "control" | "shift" | "alt";

/** `CmdOrCtrl+Shift+D` → the key event Electron's `sendInputEvent` replays. */
export function acceleratorToKey(
  accelerator: string,
  platform: NodeJS.Platform,
): { keyCode: string; modifiers: Modifier[] } {
  const parts = accelerator.split("+");
  const keyCode = parts.pop() ?? "";
  const modifiers = parts.map((part): Modifier => {
    if (part === "CmdOrCtrl") return platform === "darwin" ? "meta" : "control";
    if (part === "Ctrl") return "control";
    if (part === "Shift") return "shift";
    return "alt";
  });
  return { keyCode, modifiers };
}

/** Replays a shortcut into a page as a key press, as if the person had typed it there. */
export function replayChord(
  contents: Pick<WebContents, "sendInputEvent">,
  accelerator: string,
  platform: NodeJS.Platform,
): void {
  const { keyCode, modifiers } = acceleratorToKey(accelerator, platform);
  for (const type of ["keyDown", "keyUp"] as const)
    contents.sendInputEvent({ type, keyCode, modifiers });
}

/** The fields of Electron's `before-input-event` input that name a chord. */
export interface KeyInput {
  type: string;
  key: string;
  code: string;
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
}

/** Physical keys whose accelerator name is the character on a US layout. */
const punctuation: Readonly<Record<string, string>> = {
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Minus: "-",
  Equal: "=",
};

/**
 * The accelerator key a press names: the typed letter where there is one (so the layout's
 * letters count), otherwise the physical key (⌥ and ⇧ change the character, not the key).
 */
function pressedKey(input: KeyInput): string | undefined {
  if (/^[a-z]$/i.test(input.key)) return input.key.toUpperCase();
  return (
    /^Key([A-Z])$/.exec(input.code)?.[1] ??
    /^Digit([0-9])$/.exec(input.code)?.[1] ??
    punctuation[input.code]
  );
}

/**
 * The app shortcut a key press inside an embedded browser page means, or undefined when the
 * press belongs to the page: plain typing, the page's own chords (⌘L, ⌘R) and the shortcuts
 * marked `pageOwned`.
 */
export function appChord(input: KeyInput, platform: NodeJS.Platform): string | undefined {
  if (input.type !== "keyDown" && input.type !== "keyUp") return undefined;
  if (!input.meta && !input.control && !input.alt) return undefined;
  const key = pressedKey(input);
  if (!key) return undefined;
  for (const shortcut of shortcuts) {
    if (shortcut.pageOwned) continue;
    const chord = acceleratorToKey(shortcut.accelerator, platform);
    if (chord.keyCode !== key) continue;
    const held = new Set(chord.modifiers);
    if (
      held.has("meta") === input.meta &&
      held.has("control") === input.control &&
      held.has("shift") === input.shift &&
      held.has("alt") === input.alt
    )
      return shortcut.accelerator;
  }
  return undefined;
}

/** Toolbar shortcuts belong to ace's browser controls, not an unhandled Chromium key. */
export function browserChord(input: KeyInput, platform: NodeJS.Platform): string | undefined {
  if (input.type !== "keyDown" && input.type !== "keyUp") return;
  if (
    input.shift ||
    input.alt ||
    (platform === "darwin" ? !input.meta || input.control : !input.control || input.meta)
  )
    return;
  const key = pressedKey(input);
  return key && ["L", "R", "F", "[", "]"].includes(key) ? `CmdOrCtrl+${key}` : undefined;
}
