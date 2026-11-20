import { matchesChord } from "@/lib/hotkeys.ts";
import { bindingsFor, resolveKeymap, type KeyboardEnv } from "@/lib/keybindings.ts";
import { parseChord, type KeymapId } from "@/lib/keymap.ts";

/*
 * The editor's keyboard map (docs/editor/workbench.md, "Keyboard map"): which `editor`-scoped
 * command a key press inside the editor means. The editor handles a match and stops it, so the same
 * keys keep their app-wide meaning everywhere else. ⌘K ⌘W is a sequence: ⌘K waits for its
 * second key, and anything else lets the palette open.
 */

export type EditorPanelCommand =
  | "save"
  | "saveAll"
  | "close"
  | "closeAll"
  | "reopen"
  | "recent"
  | "recentBack"
  | "moveEditorBack"
  | "moveEditorOn"
  | "splitRight"
  | "splitDown"
  | "explorer"
  | "searchFiles"
  | "nextHit"
  | "previousHit"
  | "nextChange"
  | "previousChange"
  | "composer";

const single: readonly [KeymapId, EditorPanelCommand][] = [
  ["editor.save", "save"],
  ["editor.saveAll", "saveAll"],
  ["editor.close", "close"],
  ["editor.reopen", "reopen"],
  ["editor.moveEditorBack", "moveEditorBack"],
  ["editor.moveEditorOn", "moveEditorOn"],
  ["editor.splitRight", "splitRight"],
  ["editor.splitDown", "splitDown"],
  ["editor.explorer", "explorer"],
  ["files.search", "searchFiles"],
  ["editor.composer", "composer"],
];

/** Shift turns these into their reverse. */
const stepping: readonly [KeymapId, EditorPanelCommand, EditorPanelCommand][] = [
  ["editor.recent", "recent", "recentBack"],
  ["editor.nextHit", "nextHit", "previousHit"],
  ["editor.nextChange", "nextChange", "previousChange"],
];

export interface EditorKeys {
  /** What this press means inside the editor; undefined lets it through. */
  press(event: KeyboardEvent): EditorPanelCommand | undefined;
  /** ⌘K started a sequence and waits for its second key. */
  waiting(): boolean;
  /** Give up the wait (its time ran out): the press it held means what it means elsewhere. */
  cancel(): void;
}

/** The editor's keys for one platform. They are fixed (not rebindable), so the defaults hold. */
export function editorKeys(env: KeyboardEnv): EditorKeys {
  const resolved = resolveKeymap({}, env);
  const chords = (id: KeymapId) => bindingsFor(id, resolved, env).map(parseChord);
  const matches = (event: KeyboardEvent, id: KeymapId) =>
    chords(id).some((chord) => matchesChord(event, chord, env.apple));
  const [first, second] = (bindingsFor("editor.closeAll", resolved, env)[0] ?? "")
    .split(" ")
    .map(parseChord);
  let held = false;
  return {
    press(event) {
      if (held) {
        held = false;
        if (second && matchesChord(event, second, env.apple)) return "closeAll";
      }
      if (first && matchesChord(event, first, env.apple)) {
        held = true;
        return undefined;
      }
      for (const [id, command] of single) if (matches(event, id)) return command;
      for (const [id, forward, back] of stepping) {
        const [main, reverse] = chords(id);
        if (main && matchesChord(event, main, env.apple)) return forward;
        if (reverse && matchesChord(event, reverse, env.apple)) return back;
      }
      return undefined;
    },
    waiting: () => held,
    cancel: () => {
      held = false;
    },
  };
}
