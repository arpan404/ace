/*
 * Shortcut resolution moved to the foundation (`@/lib/keybindings.ts`) so the shell, menus,
 * tooltips and hotkeys can apply rebindings (ST-01). Import from there; these names stay for
 * the Keyboard page until it does.
 */
export {
  conflictFor,
  normalizeKeys,
  recordChord,
  resolveKeymap,
  useResolvedKeymap as useKeymap,
  type Recorded,
  type ResolvedKeymap,
} from "@/lib/keybindings.ts";
