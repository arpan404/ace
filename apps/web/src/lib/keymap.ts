/**
 * Every global shortcut, in one place. Tooltips, menus, the palette and Settings › Keyboard
 * read labels and keys from here; `useHotkey` binds them. Notation: "mod" is ⌘ on Apple
 * platforms and Ctrl elsewhere; a space separates the keys of a sequence ("g h").
 */
export const keymap = {
  palette: { keys: "mod+k", label: "Command palette" },
  newThread: { keys: "mod+n", label: "New thread" },
  newDeck: { keys: "shift+mod+n", label: "New deck" },
  back: { keys: "mod+[", label: "Back" },
  forward: { keys: "mod+]", label: "Forward" },
  toggleSidebar: { keys: "mod+\\", label: "Hide or show the sidebar" },
  agents: { keys: "mod+j", label: "Agents" },
  changes: { keys: "shift+mod+d", label: "Changes" },
  bottomPanel: { keys: "ctrl+`", label: "Terminal" },
  takeControl: { keys: "ctrl+shift+c", label: "Take or hand back browser control" },
  settings: { keys: "mod+,", label: "Settings" },
  send: { keys: "mod+enter", label: "Send" },
  goHome: { keys: "g h", label: "Go to Home" },
  goActivity: { keys: "g a", label: "Go to Activity" },
  goDeck: { keys: "g d", label: "Go to Deck" },
  goAutomations: { keys: "g u", label: "Go to Automations" },
  goSkills: { keys: "g s", label: "Go to Skills" },
} as const satisfies Record<string, { keys: string; label: string }>;

export type KeymapId = keyof typeof keymap;

const apple = /Mac|iPhone|iPad/.test(globalThis.navigator?.userAgent ?? "Mac");

const glyphs: Record<string, [apple: string, other: string]> = {
  mod: ["⌘", "Ctrl+"],
  shift: ["⇧", "Shift+"],
  ctrl: ["⌃", "Ctrl+"],
  alt: ["⌥", "Alt+"],
  enter: ["↵", "Enter"],
  escape: ["esc", "Esc"],
  arrowup: ["↑", "↑"],
  arrowdown: ["↓", "↓"],
};

/** "shift+mod+n" → "⇧⌘N" on Apple platforms, "Shift+Ctrl+N" elsewhere. */
export function formatKeys(keys: string, isApple = apple): string {
  return keys
    .split(" ")
    .map((chord) =>
      chord
        .split(/\+(?!$)/)
        .map((part) => {
          const glyph = glyphs[part.toLowerCase()];
          return glyph ? glyph[isApple ? 0 : 1] : part.toUpperCase();
        })
        .join(""),
    )
    .join(" ");
}
