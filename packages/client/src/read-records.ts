import { ThreadListView, ThreadView } from "@ace/protocol";
import type { ThreadExport } from "./api.ts";

/*
 * The records views keep between sessions (ADR 0030), and their parsing. Pure. A record comes
 * from disk and maybe from another build: anything that does not parse, or names another
 * version, is a miss, never an error.
 *
 * Version 2: every item a thread record holds carries its daemon creation sequence, which is its
 * place in every transcript (ADR 0062). Records from builds before that (version 1, or none)
 * are discarded, since an item without a sequence has no order to merge by.
 */
export const readRecordVersion = 2;

export interface ThreadRecord {
  version: typeof readRecordVersion;
  view: NonNullable<ThreadExport["view"]>;
  truncated: string[];
}

/** What a thread store keeps of `exported`, or undefined when it holds no view yet. */
export function threadRecord(exported: ThreadExport): ThreadRecord | undefined {
  if (!exported.view) return undefined;
  return { version: readRecordVersion, view: exported.view, truncated: exported.truncated };
}

/**
 * The thread view in `value`, if it is a current record of `threadId` whose items are each
 * held with their creation sequence, in that order.
 */
export function parseThreadRecord(
  value: unknown,
  threadId: string,
): { view: ThreadView; truncated: string[] } | undefined {
  if (typeof value !== "object" || value === null || !("version" in value)) return undefined;
  if (value.version !== readRecordVersion || !("view" in value)) return undefined;
  const raw = value.view;
  if (typeof raw !== "object" || raw === null) return undefined;
  const parsed = ThreadView.safeParse({ ...raw, kind: "thread" });
  if (!parsed.success || parsed.data.thread.id !== threadId) return undefined;
  const view = parsed.data;
  const seqs = view.itemSeqs;
  if (!seqs) return undefined;
  let previous = 0;
  for (const id of view.itemOrder) {
    const seq = Object.hasOwn(seqs, id) ? seqs[id] : undefined;
    if (seq === undefined || seq <= previous || !Object.hasOwn(view.items, id)) return undefined;
    previous = seq;
  }
  const truncated =
    "truncated" in value && Array.isArray(value.truncated)
      ? value.truncated.filter(
          (id): id is string => typeof id === "string" && Object.hasOwn(view.items, id),
        )
      : [];
  return { view, truncated };
}

/** Which half of the thread list a sidebar record holds: the one its filter shows. */
export type SidebarHalf = "home" | "archive";

export function sidebarRecord(half: SidebarHalf, view: ThreadListView | undefined): unknown {
  return view && { version: readRecordVersion, [half]: view };
}

function listHalf(raw: unknown): ThreadListView | undefined {
  if (raw === undefined) return undefined;
  const parsed = ThreadListView.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** Each half of the list `value` holds; a half that does not parse is left out. */
export function parseSidebarRecord(value: unknown): Partial<Record<SidebarHalf, ThreadListView>> {
  if (typeof value !== "object" || value === null || !("version" in value)) return {};
  if (value.version !== readRecordVersion) return {};
  const home = listHalf("home" in value ? value.home : undefined);
  const archive = listHalf("archive" in value ? value.archive : undefined);
  return { ...(home ? { home } : {}), ...(archive ? { archive } : {}) };
}
