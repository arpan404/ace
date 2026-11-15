import { childAskingLabel } from "@ace/ui-core";
import type { Live } from "@/lib/live-connection.ts";

/*
 * Words the composer's strip derives from a child's state. Each takes `live` first, required,
 * and returns the stale words before reading any state while the copy isn't current. The
 * `ace/live-words` lint rule keeps the ui-core formatters these wrap to files named
 * live-words.ts.
 */

/** "Reviewer needs you" for a child's request; "Reviewer: Syncing…" while not current. */
export function childAskingWords(live: Live, name: string): { text: string; needsYou: boolean } {
  if (!live.current) return { text: `${name}: ${live.word}`, needsYou: false };
  return { text: childAskingLabel(name), needsYou: true };
}
