import { matchesChord, parseChord } from "@/lib/hotkeys.ts";

/**
 * The file tree's own shortcuts, as its rows answer them and as its menus show them beside each
 * action. They only act while a row has focus, so they never shadow the app's shortcuts.
 */
export const treeKeys = {
  open: "enter",
  openTab: "mod+enter",
  reveal: "alt+mod+r",
  rename: "f2",
  move: "mod+shift+m",
  delete: "delete",
  cut: "mod+x",
  copy: "mod+c",
  paste: "mod+v",
  copyPath: "alt+mod+c",
  copyRelativePath: "alt+shift+mod+c",
  findInFolder: "alt+shift+f",
  selectAll: "mod+a",
} as const;

export type TreeAction = keyof typeof treeKeys;

const chords = Object.entries(treeKeys).map(
  ([action, keys]) => [action as TreeAction, parseChord(keys)] as const,
);

/** The tree action a keydown on a row asks for, if any. Backspace (⌘⌫ too) deletes, as on a Mac. */
export function treeAction(event: KeyboardEvent): TreeAction | undefined {
  if (event.key === "Backspace" && !event.shiftKey && !event.altKey) return "delete";
  return chords.find(([, chord]) => matchesChord(event, chord))?.[0];
}
