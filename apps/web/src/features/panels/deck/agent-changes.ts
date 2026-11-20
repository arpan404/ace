import { fileChanges, type Turn } from "@ace/ui-core";
import type { Author, EditCall } from "@/features/editor-workbench/index.ts";

/*
 * Agents' changes to open files (docs/editor/workbench.md 21, 45): which open file an agent (or
 * another thread) changed on disk since the person last looked, for the tab's mark, the Open
 * editors row and the status line's "Claude Code changed 2 open files" with Next change. Pure:
 * the panel feeds it disk changes, what is on screen, and the turn's edit calls.
 */

/** A change someone can be named for. */
export type NamedAuthor = Exclude<Author, { kind: "unknown" }>;

/** Unseen changes by path, oldest first. */
export type AgentChanges = ReadonlyMap<string, NamedAuthor>;

export const noChanges: AgentChanges = new Map();

/** A file changed on disk by `author`. A change nobody can be named for leaves no mark. */
export function recordChange(changes: AgentChanges, path: string, author: Author): AgentChanges {
  if (author.kind === "unknown") return changes;
  const next = new Map(changes);
  next.delete(path);
  next.set(path, author);
  return next;
}

/** The person looked at these paths (each focused group's shown file): their marks go. */
export function seeChanges(changes: AgentChanges, seen: Iterable<string>): AgentChanges {
  let next: Map<string, NamedAuthor> | undefined;
  for (const path of seen) {
    if (!changes.has(path)) continue;
    next ??= new Map(changes);
    next.delete(path);
  }
  return next ?? changes;
}

/** Only the paths still open: a closed file's mark goes with its tab. */
export function keepOpen(changes: AgentChanges, open: readonly string[]): AgentChanges {
  const still = new Set(open);
  return [...changes.keys()].every((path) => still.has(path))
    ? changes
    : new Map([...changes].filter(([path]) => still.has(path)));
}

const nameOf = (author: NamedAuthor) => (author.kind === "agent" ? author.agent : author.title);

/** The status line's words: "Claude Code changed 2 open files"; undefined with nothing unseen. */
export function changeNotice(changes: AgentChanges): string | undefined {
  if (changes.size === 0) return undefined;
  const names = [...new Set([...changes.values()].map(nameOf))];
  const who =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
  const count = changes.size === 1 ? "1 open file" : `${changes.size} open files`;
  return `${who} changed ${count}`;
}

/** Next change (⌥F5): the unseen path after `current` in open order, wrapping; ⇧ goes back. */
export function nextChange(
  changes: AgentChanges,
  open: readonly string[],
  current: string | undefined,
  direction: 1 | -1 = 1,
): string | undefined {
  const order = open.filter((path) => changes.has(path));
  if (order.length === 0) return undefined;
  const at = current === undefined ? -1 : open.indexOf(current);
  const ahead = (path: string) => (open.indexOf(path) - at) * direction;
  const later = order.filter((path) => ahead(path) > 0).toSorted((a, b) => ahead(a) - ahead(b));
  if (later[0] !== undefined) return later[0];
  const wrapped = order.toSorted((a, b) => (open.indexOf(a) - open.indexOf(b)) * direction);
  return wrapped[0];
}

/**
 * The edit calls this thread's turns reported, for the attribution matcher: one per changed path
 * (a move counts for its destination too), at the earlier of when the call was made and when this
 * client first saw it, so neither a slow clock nor a history load moves it into the window.
 */
export function editCallsOf(
  turns: readonly Turn[],
  thread: Pick<EditCall, "threadId" | "threadTitle" | "agent">,
  firstSeen: (itemId: string) => number,
): EditCall[] {
  const calls: EditCall[] = [];
  for (const turn of turns)
    for (const edit of turn.edits) {
      const at = Math.min(edit.createdAt, firstSeen(edit.id));
      for (const change of fileChanges(edit))
        for (const path of change.movePath ? [change.path, change.movePath] : [change.path])
          calls.push({ ...thread, path, at });
    }
  return calls;
}
