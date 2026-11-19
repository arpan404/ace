import type {
  ForgeInboxList,
  ForgeInboxRow,
  ForgeInboxWrite,
  ForgeRepository,
} from "@ace/protocol";
import { sameRepository } from "./project-repository-edit.ts";

/*
 * What the person's inbox writes do to the rows on show, shared by the web's Inbox and the
 * phone's: which writes Mark all read sends, and how a page reads once a write has landed but
 * GitHub's next answer may not show it yet. Pure.
 */

/** A write as the rows show it: read rows lose their dot, done rows leave. */
export type InboxChange =
  | { kind: "read" | "done"; ids: ReadonlySet<string> }
  /** Everything GitHub had by `before` (epoch ms) is read, in one repository or everywhere. */
  | { kind: "read-all"; before: number; repository?: ForgeRepository | undefined };

/**
 * A page as it reads once a write lands. Mark all read covers what GitHub had by `before`;
 * anything newer stays unread, as it does on GitHub.
 */
export function afterWrite(page: ForgeInboxList, change: InboxChange): ForgeInboxList {
  if (change.kind === "done")
    return { ...page, items: page.items.filter((row) => !change.ids.has(row.id)) };
  const reads = (row: ForgeInboxRow) =>
    change.kind === "read-all"
      ? Date.parse(row.updatedAt) <= change.before &&
        (!change.repository || sameRepository(row.repository, change.repository))
      : change.ids.has(row.id);
  const items = page.items.map((row) =>
    row.unread && reads(row) ? { ...row, unread: false } : row,
  );
  return { ...page, items };
}

/**
 * The writes Mark all read sends. GitHub can mark everything read, or one repository's, up to a
 * moment; it can't mark only participating threads, one reason's, some projects' or a search's,
 * so when the rows on show are narrowed so, each unread one is marked on its own.
 */
export function markAllReadWrites(input: {
  /** The rows on show are fewer than GitHub's unread for the repository (or everywhere). */
  narrowed: boolean;
  /** The unread rows on show, in order. */
  unread: readonly string[];
  /** The moment of the press, epoch ms. */
  before: number;
  repository?: ForgeRepository | undefined;
}): ForgeInboxWrite[] {
  if (input.narrowed) return input.unread.map((id) => ({ action: "read", id }));
  return [
    {
      action: "read-all",
      before: new Date(input.before).toISOString(),
      ...(input.repository ? { repository: input.repository } : {}),
    },
  ];
}

/**
 * GitHub applies Mark all read in the background, so within one poll interval of it a read may
 * still show those rows unread: until then the rows keep the change shown.
 */
export function readAllApplying(sentAt: number | undefined, now: number, pollSeconds: number) {
  return sentAt !== undefined && now - sentAt < pollSeconds * 1_000;
}
