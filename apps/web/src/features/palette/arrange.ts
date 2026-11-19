import { compareRanked, rankCommand } from "@ace/ui-core/command-rank";
import type { PaletteCommand, PaletteGroup } from "./types.ts";
import type { RecentEntry } from "./recent.ts";

/** Threads in a ranked list, at most. */
const threadMatches = 30;
/** Recently run commands lifted to the top of Actions. */
const recentActions = 5;
/** Recent threads and recent chats an empty All lists, each. */
const recentEach = 5;
/** Message results are asked for from this many characters. */
export const messageMinLength = 2;

/** What the palette searches: everything, or one kind, chosen by its tabs (Tab moves along). */
export const paletteScopes = [
  { id: "all", label: "All" },
  { id: "actions", label: "Actions" },
  { id: "threads", label: "Threads" },
  { id: "chats", label: "Chats" },
  { id: "messages", label: "Messages" },
] as const;
export type PaletteScope = (typeof paletteScopes)[number]["id"];

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
const isThread = (item: PaletteCommand) => item.kind === "thread" && item.chat !== true;
const isChat = (item: PaletteCommand) => item.kind === "thread" && item.chat === true;

export interface ArrangeInput {
  groups: readonly PaletteGroup[];
  query: string;
  /** Which tab is open; `>` before the query means Actions whatever the tab. */
  scope?: PaletteScope | undefined;
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

/** Threads opened lately first, then Home's order, without the open one, that `keep` keeps. */
function recentOf(input: ArrangeInput, keep: (row: Row) => boolean, limit: number): Row[] {
  const threads = input.groups.find((group) => group.value === "Threads")?.items ?? [];
  const byId = new Map(threads.map((item) => [item.id, item]));
  const currentId = input.current ? `thread-${input.current}` : undefined;
  const opened = input.recentThreads.flatMap((entry) => byId.get(`thread-${entry.id}`) ?? []);
  return [...new Set([...opened, ...threads])]
    .filter((item) => item.id !== currentId && keep(item))
    .slice(0, limit);
}

/** What an empty palette lists in each tab. */
function resting(input: ArrangeInput, scope: PaletteScope, all: readonly Row[]): RowGroup[] {
  if (scope === "actions") {
    const actions = actionsFirst(all, input.recentCommands, all.filter(isAction));
    return actions.length ? [{ value: "Actions", items: actions }] : [];
  }
  if (scope === "threads") {
    const items = recentOf(input, isThread, threadMatches);
    return items.length ? [{ value: "Threads", items }] : [];
  }
  if (scope === "chats") {
    const items = recentOf(input, isChat, threadMatches);
    return items.length ? [{ value: "Chats", items }] : [];
  }
  // Messages wait for words to look for.
  if (scope === "messages") return [];
  // All: the threads the person picked, if any, then a few ways to start, then where the person
  // was. What acts on an open thread waits for a query or the Actions tab, so the palette opens
  // clean.
  const out: RowGroup[] = [];
  const selected = input.groups.find((group) => group.value === "Selected threads")?.items ?? [];
  if (selected.length) out.push({ value: "Selected threads", items: selected });
  const quick = input.groups.find((group) => group.value === "Create")?.items ?? [];
  if (quick.length) out.push({ value: "Quick actions", items: quick });
  const threads = recentOf(input, isThread, Math.min(recentEach, input.recentLimit));
  if (threads.length) out.push({ value: "Threads", items: threads });
  const chats = recentOf(input, isChat, Math.min(recentEach, input.recentLimit));
  if (chats.length) out.push({ value: "Chats", items: chats });
  return out;
}

const inScope: Record<PaletteScope, (row: Row) => boolean> = {
  all: () => true,
  actions: isAction,
  threads: isThread,
  chats: isChat,
  messages: () => false,
};

/**
 * The palette's rows for its tab (`scope`). Empty, All offers Quick actions, then recent Threads
 * and recent Chats; Actions lists every action (recently run first); Threads and Chats their
 * recent ones; Messages waits for a query. A query: one list ranked across what the tab holds
 * (every word must match; ties go to the more recent), then messages found inside threads (All
 * and Messages), then the way into full search. `>` keeps actions only, whatever the tab.
 */
export function arrange(input: ArrangeInput): RowGroup[] {
  const { text, actionsOnly } = readQuery(input.query);
  const scope: PaletteScope = actionsOnly ? "actions" : (input.scope ?? "all");
  const all = unique(input.groups);
  if (!text) return resting(input, scope, all);
  const used = new Map(input.recentCommands.map((entry) => [entry.id, entry.at]));
  const openedAt = new Map(input.recentThreads.map((entry) => [`thread-${entry.id}`, entry.at]));
  const scored: { row: Row; score: number; at: number | undefined }[] = [];
  for (const row of all) {
    if (!inScope[scope](row)) continue;
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
  if (scope === "actions") return out;
  if (scope === "all" || scope === "messages") {
    // A thread already listed isn't repeated for a message inside it.
    const listed = new Set(results.map((row) => row.id));
    const messages =
      text.length >= messageMinLength
        ? input.messages.filter(
            (row) => !listed.has(row.id) && !listed.has(`thread-${row.threadId ?? ""}`),
          )
        : [];
    if (messages.length) out.push({ value: "Messages", items: messages, labelled: true });
  }
  const more = input.searchAll?.(text);
  if (more) {
    const last = out.at(-1);
    if (last) last.items = [...last.items, more];
    else out.push({ value: "Results", items: [more] });
  }
  return out;
}
