import { homeRowThread, type HomeRow } from "@ace/ui-core";
import { parseChord } from "@/lib/keymap.ts";

/** Rows a number opens: the threads as drawn, never a heading, the Unsent block or a leaving row. */
const numbered = new Set<HomeRow["kind"]>(["pinned", "thread", "snoozed", "settled"]);

/**
 * The threads ⌘1 to ⌘9 open, in the order the list draws them: the first nine thread rows
 * (pinned, then the rest, then Snoozed and Settled while those are open).
 */
export function jumpTargets(rows: readonly { item: HomeRow; phase: string }[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (ids.length === 9) break;
    if (row.phase === "exit" || !numbered.has(row.item.kind)) continue;
    const id = homeRowThread(row.item);
    if (id) ids.push(id);
  }
  return ids;
}

/** "alt+mod+1" → the nine chords "alt+mod+1" … "alt+mod+9". */
export function jumpChords(first: string): string[] {
  const stem = first.replace(/\d$/, "");
  return Array.from({ length: 9 }, (_, index) => `${stem}${index + 1}`);
}

/**
 * Whether exactly the chord's modifiers are held now, and nothing else: what shows the rows'
 * numbers. Matched as `matchesChord` matches them, ⌘ and ⌃ apart on Apple platforms.
 */
export function holdsJumpModifiers(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "key">,
  first: string,
  isApple: boolean,
): boolean {
  if (!["Meta", "Control", "Alt", "Shift"].includes(event.key)) return false;
  const chord = parseChord(first);
  const modifiers = isApple
    ? event.metaKey === chord.mod && event.ctrlKey === chord.ctrl
    : (event.ctrlKey || event.metaKey) === (chord.mod || chord.ctrl);
  return modifiers && event.altKey === chord.alt && event.shiftKey === chord.shift;
}
