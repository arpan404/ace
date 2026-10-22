import type { ForgeInboxList, ForgeInboxQuery, ForgeInboxRow } from "@ace/protocol";
import { inboxReasons, inboxReasonWords } from "@ace/ui-core";
import { repositoryFromParam, repositoryParam } from "@/lib/pull-request-route.ts";

/** `/inbox?view=all&reason=mention&repo=github.com/acme/ace`: the inbox's filters, in the address. */
export interface InboxSearch {
  project?: string | undefined;
  /** Read notifications too; unread only when absent. */
  view?: "all" | undefined;
  /** Only threads the person takes part in. */
  only?: "participating" | undefined;
  reason?: string | undefined;
  /** One repository (`github.com/acme/ace`). */
  repo?: string | undefined;
}

/** What GitHub is asked for: unread or all, participating, one repository. Reason is filtered here. */
export function inboxQuery(search: InboxSearch, page: number): ForgeInboxQuery {
  const repository = repositoryFromParam(search.repo);
  return {
    all: search.view === "all",
    participating: search.only === "participating",
    ...(repository ? { repository } : {}),
    page,
  };
}

/** The rows to show: one per thread across pages, of the chosen reason. */
export function visibleRows(
  pages: readonly (ForgeInboxList | undefined)[],
  search: InboxSearch,
): ForgeInboxRow[] {
  const seen = new Set<string>();
  const rows: ForgeInboxRow[] = [];
  for (const page of pages)
    for (const row of page?.items ?? []) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      if (!search.reason || row.reason === search.reason) rows.push(row);
    }
  return rows;
}

const unique = (values: Iterable<string>) => [...new Set(values)];

/** The reason filter's choices: GitHub's usual reasons, then any others the rows name. */
export function reasonChoices(rows: readonly ForgeInboxRow[], selected: string | undefined) {
  return unique([
    ...inboxReasons,
    ...rows.map((row) => row.reason),
    ...(selected ? [selected] : []),
  ]).map((value) => ({ value, label: inboxReasonWords(value) }));
}

/** The repository filter's choices: every repository the rows come from, by name. */
export function repositoryChoices(rows: readonly ForgeInboxRow[], selected: string | undefined) {
  return unique([
    ...rows.map((row) => repositoryParam(row.repository)),
    ...(selected ? [selected] : []),
  ])
    .toSorted((a, b) => a.localeCompare(b))
    .map((value) => ({ value, label: value.split("/").slice(1).join("/") }));
}

/**
 * A page as it reads once a write lands: read rows lose their dot, done rows leave. Mark all read
 * covers what GitHub had by `before`; anything newer stays unread, as it does on GitHub.
 */
export function afterWrite(
  page: ForgeInboxList,
  change:
    | { kind: "read" | "done"; ids: ReadonlySet<string> }
    | { kind: "read-all"; before: number; repo?: string | undefined },
): ForgeInboxList {
  if (change.kind === "done")
    return { ...page, items: page.items.filter((row) => !change.ids.has(row.id)) };
  const reads = (row: ForgeInboxRow) =>
    "ids" in change
      ? change.ids.has(row.id)
      : Date.parse(row.updatedAt) <= change.before &&
        (!change.repo || repositoryParam(row.repository) === change.repo);
  const items = page.items.map((row) =>
    row.unread && reads(row) ? { ...row, unread: false } : row,
  );
  return { ...page, items };
}

/** Refusals asking again won't change: the person fixes them, then tries again. */
const settled = new Set([
  "forge_notifications_unavailable",
  "forge_unsupported",
  "forge_forbidden",
]);
/** Refusals that pass: a rate limit or a lost connection, asked again after a longer wait. */
const passing = new Set(["forge_rate_limit", "forge_offline"]);
export const inboxBackoffMs = 5 * 60_000;

/**
 * How long until the inbox asks again: GitHub's poll interval; never after a refusal that won't
 * pass by itself; a few minutes after a rate limit or a lost connection.
 */
export function inboxPollMs(
  data: ForgeInboxList | undefined,
  failure: string | undefined,
): number | false {
  if (failure && settled.has(failure)) return false;
  if (failure && passing.has(failure)) return inboxBackoffMs;
  return (data?.pollSeconds ?? 60) * 1_000;
}
