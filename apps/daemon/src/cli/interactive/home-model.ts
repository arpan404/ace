import { ThreadId } from "@ace/protocol";
import { isCtrl, typed, type Key } from "../tui/keys.ts";
import { stay, step, type Step } from "./effects.ts";
import type { HomeRow } from "./home-rows.ts";

/**
 * The home's state over key presses (ADR 0176 §9). Pure: rows come from `homeRows`, keys from
 * the terminal; what the keys ask for comes back as effects.
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

function move(state: HomeState, rows: readonly HomeRow[], by: number): HomeState {
  const visible = filtered(rows, state.filter.text);
  if (!visible.length) return state;
  const current = visible.findIndex((row) => row.id === selectedRow(state, rows)?.id);
  const next = Math.max(0, Math.min(visible.length - 1, current + by));
  const id = visible[next]?.id;
  return { ...state, selected: id, open: state.open === id ? state.open : undefined };
}

function filterKey(state: HomeState, key: Key): Step<HomeState> {
  const text = state.filter.text;
  if (key.name === "escape") return stay({ ...state, filter: { text: "", editing: false } });
  if (key.name === "enter") return stay({ ...state, filter: { text, editing: false } });
  if (key.name === "backspace")
    return stay({
      ...state,
      filter: { text: Array.from(text).slice(0, -1).join(""), editing: true },
    });
  const char = typed(key) ?? (key.name === "paste" ? key.text?.replace(/\s+/g, " ") : undefined);
  if (char !== undefined) return stay({ ...state, filter: { text: text + char, editing: true } });
  return stay(state);
}

export function homeKey(state: HomeState, rows: readonly HomeRow[], key: Key): Step<HomeState> {
  const quiet = { ...state, notice: undefined };
  if (isCtrl(key, "c")) return step(state, { kind: "quit", farewell: "", code: 130 });
  if (state.filter.editing) return filterKey(quiet, key);
  const row = selectedRow(state, rows);
  if (state.confirmStop) {
    const id = state.confirmStop;
    const cleared = { ...quiet, confirmStop: undefined };
    if (typed(key) === "y" || key.name === "enter")
      return step(cleared, {
        kind: "command",
        payload: { type: "thread.interrupt", threadId: ThreadId.parse(id), cascade: true },
        done: "Stopping it and every agent under it.",
      });
    return stay({ ...cleared, notice: "Nothing was stopped." });
  }
  if (state.help) return stay({ ...quiet, help: false });
  if (key.name === "up" || typed(key) === "k") return stay(move(quiet, rows, -1));
  if (key.name === "down" || typed(key) === "j") return stay(move(quiet, rows, 1));
  if (key.name === "pageup") return stay(move(quiet, rows, -10));
  if (key.name === "pagedown") return stay(move(quiet, rows, 10));
  if (key.name === "escape") {
    if (state.open)
      return step({ ...quiet, open: undefined }, { kind: "tree", threadId: undefined });
    if (state.filter.text) return stay({ ...quiet, filter: { text: "", editing: false } });
    return stay(quiet);
  }
  const char = typed(key);
  switch (char) {
    case "q":
      return step(quiet, { kind: "quit", farewell: "", code: 0 });
    case "/":
      return stay({ ...quiet, filter: { text: state.filter.text, editing: true } });
    case "?":
      return stay({ ...quiet, help: true });
    case "n":
      return step(quiet, { kind: "new-thread" });
    case "r":
      return step(quiet, { kind: "requests" });
    case "p":
      return step(quiet, { kind: "place", place: "projects" });
    case "s":
      return step(quiet, { kind: "place", place: "spade" });
    case "m":
      return step(quiet, { kind: "place", place: "market" });
    case ",":
      return step(quiet, { kind: "place", place: "settings" });
    case "d":
      return step(quiet, { kind: "doctor" });
  }
  if (!row) return stay(quiet);
  const selected = { ...quiet, selected: row.id };
  if (key.name === "enter") return step(selected, { kind: "attach", threadId: row.id });
  if (key.name === "right" || typed(key) === "l") {
    if (state.open === row.id) return stay(selected);
    return step({ ...selected, open: row.id }, { kind: "tree", threadId: row.id });
  }
  if (key.name === "left" || typed(key) === "h")
    return state.open
      ? step({ ...selected, open: undefined }, { kind: "tree", threadId: undefined })
      : stay(selected);
  const threadId = ThreadId.parse(row.id);
  switch (char) {
    case "x":
      if (!row.running) return stay({ ...selected, notice: "Nothing in that thread is running." });
      return stay({ ...selected, confirmStop: row.id });
    case "z":
      // While it works, until it needs the person: the daemon wakes it on a request.
      return step(selected, {
        kind: "command",
        payload: {
          type: "thread.snooze",
          threadId,
          until: null,
          ...(row.running ? { wake: "needs_you" as const } : {}),
        },
        done: row.running ? `Snoozed ${row.title} until it needs you.` : `Snoozed ${row.title}.`,
      });
    case "e":
      return step(selected, {
        kind: "command",
        payload: { type: "thread.settle", threadId },
        done: `Settled ${row.title}.`,
      });
  }
  return stay(selected);
}
