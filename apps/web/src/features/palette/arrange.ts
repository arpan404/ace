import { compareRanked, rankCommand } from "@ace/ui-core/command-rank";
import type { PaletteCommand, PaletteGroup } from "./types.ts";
import type { RecentEntry } from "./recent.ts";

/** Threads in a ranked list, at most. */
const threadMatches = 30;
/** Recently run commands an empty palette lifts into Actions. */
const recentActions = 5;
/** Message results are asked for from this many characters. */
export const messageMinLength = 2;

export interface Row extends PaletteCommand {
  /** The group it came from, shown at the right of a ranked list. */
  hint?: string;
}
export interface RowGroup {
  value: string;
  items: Row[];
  /** Its label shows even in a ranked list (Messages). */
  labelled?: boolean;
}

const isAction = (item: PaletteCommand) => item.kind === undefined;
/** Groups that act on what's open or picked: an empty palette shows them whole. */
const contextual = new Set(["Agent", "Selected threads"]);

export interface ArrangeInput {
  groups: readonly PaletteGroup[];
  query: string;
  recentThreads: readonly RecentEntry[];
  recentCommands: readonly RecentEntry[];
  /** The open thread: it isn't one of the recent ones. */
  current: string | undefined;
  /** Messages found inside threads for the query. */
  messages: readonly PaletteCommand[];
  /** The way into full search for the query, last in the list. */
  searchAll: ((query: string) => PaletteCommand) | undefined;
  recentLimit: number;
}

/** A query that starts with `>` lists actions only; the rest is what's searched. */
export function readQuery(query: string): { text: string; actionsOnly: boolean } {
  const trimmed = query.trimStart();
  return trimmed.startsWith(">")
    ? { text: trimmed.slice(1).trim(), actionsOnly: true }
    : { text: query.trim(), actionsOnly: false };
}

function unique(groups: readonly PaletteGroup[]): Row[] {
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const group of groups)
    for (const item of group.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push({ ...item, hint: group.value });
    }
  return out;
}

/** Actions with the recently run first, then `rest` in its own order. */
function actionsFirst(all: readonly Row[], recent: readonly RecentEntry[], rest: readonly Row[]) {
  const byId = new Map(all.map((item) => [item.id, item]));
  const lifted = recent.flatMap((entry) => byId.get(entry.id) ?? []).slice(0, recentActions);
  const shown = new Set(lifted.map((item) => item.id));
  return [...lifted, ...rest.filter((item) => !shown.has(item.id))];
}

/**
 * The palette's rows. An empty query: what acts on the open or picked threads, then Actions
 * (recently run first, then Create), then This thread, then Recent threads (opened lately,
 * filled up from Home's order). A query: one list ranked across actions, projects, settings and
 * threads (every word must match; ties go to the more recent), then messages found inside
 * threads, then the way into full search. `>` keeps actions only.
 */
export function arrange(input: ArrangeInput): RowGroup[] {
  const { text, actionsOnly } = readQuery(input.query);
  const all = unique(input.groups);
  const used = new Map(input.recentCommands.map((entry) => [entry.id, entry.at]));
  if (!text && actionsOnly)
    return [
      { value: "Actions", items: actionsFirst(all, input.recentCommands, all.filter(isAction)) },
    ];
  if (!text) {
    const out: RowGroup[] = input.groups
      .filter((group) => contextual.has(group.value))
      .map((group) => ({ value: group.value, items: group.items }));
    const create = input.groups.find((group) => group.value === "Create")?.items ?? [];
    const actions = actionsFirst(all.filter(isAction), input.recentCommands, create);
    if (actions.length) out.push({ value: "Actions", items: actions });
    const here = input.groups.find((group) => group.value === "This thread");
    if (here) out.push({ value: here.value, items: here.items });
    const threads = input.groups.find((group) => group.value === "Threads")?.items ?? [];
    const byId = new Map(threads.map((item) => [item.id, item]));
    const currentId = input.current ? `thread-${input.current}` : undefined;
    const opened = input.recentThreads.flatMap((entry) => byId.get(`thread-${entry.id}`) ?? []);
    const recent = [...new Set([...opened, ...threads])]
      .filter((item) => item.id !== currentId)
      .slice(0, input.recentLimit);
    if (recent.length) out.push({ value: "Recent threads", items: recent });
    return out;
  }
  const openedAt = new Map(input.recentThreads.map((entry) => [`thread-${entry.id}`, entry.at]));
  const scored: { row: Row; score: number; at: number | undefined }[] = [];
  for (const row of all) {
    if (actionsOnly && !isAction(row)) continue;
    const at = isAction(row) ? used.get(row.id) : Math.max(row.at ?? 0, openedAt.get(row.id) ?? 0);
    const score = rankCommand(text, {
      label: row.label,
      fields: [row.detail, row.more, row.keywords],
    });
    if (score !== null) scored.push({ row, score, at });
  }
  scored.sort(compareRanked);
  let threadCount = 0;
  const results = scored
    .filter(({ row }) => row.kind !== "thread" || ++threadCount <= threadMatches)
    .map(({ row }) => row);
  const out: RowGroup[] = [];
  if (results.length) out.push({ value: "Results", items: results });
  if (actionsOnly) return out;
  // A thread already listed isn't repeated for a message inside it.
  const listed = new Set(results.map((row) => row.id));
  const messages =
    text.length >= messageMinLength
      ? input.messages.filter(
          (row) => !listed.has(row.id) && !listed.has(`thread-${row.threadId ?? ""}`),
        )
      : [];
  if (messages.length) out.push({ value: "Messages", items: messages, labelled: true });
  const more = input.searchAll?.(text);
  if (more) {
    const last = out.at(-1);
    if (last) last.items = [...last.items, more];
    else out.push({ value: "Results", items: [more] });
  }
  return out;
}
