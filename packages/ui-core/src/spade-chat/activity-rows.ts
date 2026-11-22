import { spadeActivityRow, type SpadeActivityEntry, type SpadeActivityRow } from "./activity.ts";

/*
 * A bot's activity as the person reads it (ADR 0135): one row per call, however many entries
 * Spade logged for it (it asked, the reviewer looked, the person allowed it, it ran), and only
 * the part of the log a place is about. Pure.
 */

/** One row of an activity list: the entry it stands for, and its words. */
export interface SpadeActivityItem {
  key: string;
  /** The entry the row stands for: the call's use when it ran, else its newest. */
  entry: SpadeActivityEntry;
  row: SpadeActivityRow;
}

/** Which part of the log a place shows: its computer's use, or everything it did. */
export type SpadeActivityScope = "computer" | "all";

const computerTool = /^(screen|browser|sim|device|emulator|computer)_/;

/** A tool that works the bot's computer: its screen and apps, its browser, devices. */
export function spadeIsComputerTool(name: string): boolean {
  const base = (name.split("__").at(-1) ?? name).replace(/^ace_/, "");
  return computerTool.test(base);
}

/** The entries `scope` shows: Computer shows only computer use; Work shows the whole log. */
export function spadeActivityInScope(
  entries: readonly SpadeActivityEntry[],
  scope: SpadeActivityScope,
): SpadeActivityEntry[] {
  return scope === "all"
    ? [...entries]
    : entries.filter((entry) => entry.name !== undefined && spadeIsComputerTool(entry.name));
}

const useKinds = new Set(["tool", "connector", "file"]);

/** The call an entry is part of: Spade's own id, else its turn and tool for an older Spade. */
function callOf(entry: SpadeActivityEntry): string | undefined {
  const kind = entry.kind ?? "";
  if (!useKinds.has(kind) && kind !== "approval" && kind !== "review") return undefined;
  if (entry.callId) return `call:${entry.callId}`;
  return entry.reply && entry.name ? `turn:${entry.reply}:${entry.name}` : undefined;
}

/** How the person, or the reviewer for them, let a call run: said after what it did. */
const letWords: Record<string, string> = {
  allowed: "you allowed it",
  always: "you always allow it",
};

/**
 * The log as rows, newest first as it came: a call's ask, the reviewer's look, the person's
 * answer and its use become one row, the use's sentence with how it was let run ("Created
 * pages in Notion · you allowed it"). A call the person declined reads as declined; one still
 * waiting on them says so. Anything that isn't a call keeps its own row.
 */
export function spadeActivityItems(entries: readonly SpadeActivityEntry[]): SpadeActivityItem[] {
  const groups = new Map<string, SpadeActivityEntry[]>();
  for (const entry of entries) {
    const key = callOf(entry) ?? `entry:${entry.id}`;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  return [...groups].map(([key, group]) => item(key, group));
}

function item(key: string, group: readonly SpadeActivityEntry[]): SpadeActivityItem {
  const [newest] = group;
  if (!newest) throw new Error("an empty group");
  if (group.length === 1) return { key, entry: newest, row: spadeActivityRow(newest) };
  // Newest first: the first answer found is the latest.
  const use = group.find((entry) => useKinds.has(entry.kind ?? ""));
  const answer = group.find((entry) => entry.kind === "approval" && entry.outcome !== "asked");
  const review = group.find((entry) => entry.kind === "review");
  const declined = answer?.outcome === "declined" || answer?.outcome === "denied";
  const asked = group.find((each) => each.kind === "approval" && each.outcome === "asked");
  const entry = declined ? answer : (use ?? answer ?? asked ?? newest);
  const row = spadeActivityRow(entry);
  const reviewed = review?.outcome === "allowed" || review?.outcome === "approved";
  const how = declined
    ? undefined
    : answer
      ? letWords[answer.outcome ?? ""]
      : reviewed
        ? "the reviewer allowed it"
        : undefined;
  // What it acted on, from the call's own entries (a review's detail is its reason).
  const detail =
    row.detail ?? group.find((each) => each.kind !== "review" && each.detail !== undefined)?.detail;
  const waiting = !use && !answer && asked !== undefined;
  return {
    key,
    entry,
    row: {
      sentence: how && entry !== answer ? `${row.sentence} · ${how}` : row.sentence,
      detail,
      exception: row.exception ?? (waiting ? { words: "Asked you", tone: "needs" } : undefined),
    },
  };
}
