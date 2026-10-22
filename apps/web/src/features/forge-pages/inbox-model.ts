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

/** A page as it reads once a write lands: read rows lose their dot, done rows leave. */
export function afterWrite(
  page: ForgeInboxList,
  change: { kind: "read" | "done"; ids: ReadonlySet<string> } | { kind: "read-all"; repo?: string },
): ForgeInboxList {
  if (change.kind === "done")
    return { ...page, items: page.items.filter((row) => !change.ids.has(row.id)) };
  const reads = (row: ForgeInboxRow) =>
    "ids" in change
      ? change.ids.has(row.id)
      : !change.repo || repositoryParam(row.repository) === change.repo;
  const items = page.items.map((row) =>
    row.unread && reads(row) ? { ...row, unread: false } : row,
  );
  return { ...page, items };
}
