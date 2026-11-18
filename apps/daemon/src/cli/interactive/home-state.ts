import type { HomeRow } from "./home-rows.ts";

/**
 * The home's state (ADR 0178 §9) and what it selects. Pure, and light to load: the first paint
 * draws from it before the client and the schemas load.
 */
export interface HomeState {
  /** The selected thread, by id, so live reordering keeps the selection on its row. */
  readonly selected: string | undefined;
  /** `/` filter: the typed words, and whether the person is still typing them. */
  readonly filter: { readonly text: string; readonly editing: boolean };
  /** The row whose agent tree is open under it (→). */
  readonly open: string | undefined;
  /** `x` asks first: the thread waiting on the person's yes. */
  readonly confirmStop: string | undefined;
  /** One quiet line under the list: what the last action did. */
  readonly notice: string | undefined;
  readonly help: boolean;
}

export const homeStart: HomeState = {
  selected: undefined,
  filter: { text: "", editing: false },
  open: undefined,
  confirmStop: undefined,
  notice: undefined,
  help: false,
};

/** Rows the filter keeps: every word appears in the title, project, branch or provider. */
export function filtered(rows: readonly HomeRow[], text: string): HomeRow[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...rows];
  return rows.filter((row) => {
    const haystack = `${row.title} ${row.project} ${row.branch} ${row.provider}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** The selected row, falling back to the first when the selected one left the list. */
export function selectedRow(state: HomeState, rows: readonly HomeRow[]): HomeRow | undefined {
  const visible = filtered(rows, state.filter.text);
  return visible.find((row) => row.id === state.selected) ?? visible[0];
}
