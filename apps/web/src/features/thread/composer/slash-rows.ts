import type { CatalogEntry } from "@ace/protocol";
import type { Suggestion } from "./suggestions.tsx";

/*
 * What a leading `/` offers in a composer with no project of its own (Spade): the screen's
 * actions, then skills, then commands, each with a name, one line and where it comes from. Pure:
 * the screen brings the rows, this filters and orders them as the thread composer's list does.
 */

export type SlashGroup = "Actions" | "Skills" | "Commands";

/** One row a screen offers behind `/`. */
export interface SlashMenuRow {
  group: SlashGroup;
  id: string;
  /** Without the slash. */
  name: string;
  description: string;
  /** Where it comes from: `Spade`, a plugin's name. */
  source: string;
  /** A skill or command: the chip it leaves in the message. */
  entry?: CatalogEntry | undefined;
}

/** What `/` offers, and what an action does when picked. */
export interface SlashMenu {
  rows: readonly SlashMenuRow[];
  onAction(id: string): void;
}

const groups: readonly SlashGroup[] = ["Actions", "Skills", "Commands"];
const mostPerGroup = 8;
const mostWhileIdle = 4;

/** 0 is the best match: the name starts with the query, then a word of it, then anywhere. */
function rankOf(row: SlashMenuRow, needle: string): number | undefined {
  if (!needle) return 0;
  const name = row.name.toLowerCase();
  if (name.startsWith(needle)) return 0;
  if (name.split(/[\s_-]+/).some((word) => word.startsWith(needle))) return 1;
  if (name.includes(needle)) return 2;
  if (row.description.toLowerCase().includes(needle)) return 3;
  return undefined;
}

/**
 * The rows the query matches, grouped. A skill or command leads the message as a chip, so it is
 * offered only where the message begins (`atStart`) and while none leads it already (`chipped`);
 * an action is offered wherever the `/` is.
 */
export function slashSuggestions(
  menu: SlashMenu,
  query: string,
  place: { atStart: boolean; chipped: boolean },
): { items: Suggestion[]; best: number } {
  const needle = query.trim().toLowerCase();
  const ranked = menu.rows.flatMap((row, index) => {
    if (row.group !== "Actions" && (!place.atStart || place.chipped)) return [];
    const rank = rankOf(row, needle);
    return rank === undefined ? [] : [{ row, rank, index }];
  });
  const picked = groups.flatMap((group) =>
    ranked
      .filter((each) => each.row.group === group)
      .toSorted((a, b) => a.rank - b.rank || a.index - b.index)
      .slice(0, needle ? mostPerGroup : mostWhileIdle),
  );
  const items = picked.map(({ row }): Suggestion => {
    const label = `/${row.name.replace(/\s+/g, "-")}`;
    return {
      insert: label,
      label,
      detail: row.description,
      source: row.source,
      kind: "command",
      group: row.group,
      ...(row.entry ? { entry: row.entry } : { action: row.id }),
    };
  });
  let best = 0;
  picked.forEach((each, index) => {
    if (each.rank < (picked[best]?.rank ?? Number.POSITIVE_INFINITY)) best = index;
  });
  return { items, best };
}
