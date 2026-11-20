import { matchesChord } from "@/lib/hotkeys.ts";
import { bindingsFor, resolveKeymap, type KeyboardEnv } from "@/lib/keybindings.ts";
import { parseChord, type KeymapId } from "@/lib/keymap.ts";

/*
 * The Deck's keyboard map (docs/editor/workbench.md, "Keyboard map"): which `deck`-scoped
 * command a key press inside the Deck means. The Deck handles a match and stops it, so the same
 * keys keep their app-wide meaning everywhere else. ⌘K ⌘W is a sequence: ⌘K waits for its
 * second key, and anything else lets the palette open.
 */

export type DeckCommand =
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

const single: readonly [KeymapId, DeckCommand][] = [
  ["deck.save", "save"],
  ["deck.saveAll", "saveAll"],
  ["deck.close", "close"],
  ["deck.reopen", "reopen"],
  ["deck.moveEditorBack", "moveEditorBack"],
  ["deck.moveEditorOn", "moveEditorOn"],
  ["deck.splitRight", "splitRight"],
  ["deck.splitDown", "splitDown"],
  ["deck.explorer", "explorer"],
  ["files.search", "searchFiles"],
  ["deck.composer", "composer"],
];

/** Shift turns these into their reverse. */
const stepping: readonly [KeymapId, DeckCommand, DeckCommand][] = [
  ["deck.recent", "recent", "recentBack"],
  ["deck.nextHit", "nextHit", "previousHit"],
  ["deck.nextChange", "nextChange", "previousChange"],
];

export interface DeckKeys {
  /** What this press means inside the Deck; undefined lets it through. */
  press(event: KeyboardEvent): DeckCommand | undefined;
  /** ⌘K started a sequence and waits for its second key. */
  waiting(): boolean;
  /** Give up the wait (its time ran out): the press it held means what it means elsewhere. */
  cancel(): void;
}

/** The Deck's keys for one platform. They are fixed (not rebindable), so the defaults hold. */
export function deckKeys(env: KeyboardEnv): DeckKeys {
  const resolved = resolveKeymap({}, env);
  const chords = (id: KeymapId) => bindingsFor(id, resolved, env).map(parseChord);
  const matches = (event: KeyboardEvent, id: KeymapId) =>
    chords(id).some((chord) => matchesChord(event, chord, env.apple));
  const [first, second] = (bindingsFor("deck.closeAll", resolved, env)[0] ?? "")
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
