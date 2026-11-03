import { AtIcon, BellIcon, EyeIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useLocation } from "@tanstack/react-router";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { ForgeInboxList, ForgeInboxRow } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import { useOpenWebAddress } from "@/components/web-link.tsx";
import { Screen } from "@/features/shell/index.ts";
import { repositoryParam } from "@/lib/pull-request-route.ts";
import { useClock } from "@/lib/time.ts";
import { FiltersMenu } from "./filters-menu.tsx";
import { ForgeList } from "./forge-list.tsx";
import { inboxKey, useInboxPages, useInboxWrites } from "./inbox-data.ts";
import {
  inboxGroups,
  inboxProjects,
  reasonChoices,
  repositoryChoices,
  rowsForProjects,
  type InboxSearch,
} from "./inbox-model.ts";
import { useProjectRepositories } from "./inbox-projects.ts";
import { TriageKeys } from "./triage-keys.tsx";
import { ProjectMenu } from "./project-menu.tsx";
import { countWords } from "./quick-views.tsx";
import { InboxRow } from "./inbox-row.tsx";
import { ListFrame } from "./list-frame.tsx";
import { RowsSkeleton } from "./list-skeletons.tsx";
import { useProjectChoice } from "./project-choice.ts";

const groupIcons = {
  review: EyeIcon,
  mentions: AtIcon,
  checks: ShieldCheckIcon,
  other: BellIcon,
} as const;

/** Unread notifications per project, for the project menu. */
function unreadCounts(
  rows: readonly ForgeInboxRow[],
  projectOf: (row: ForgeInboxRow) => string | undefined,
  projects: readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>(projects.map((id) => [id, 0]));
  for (const row of rows) {
    const project = projectOf(row);
    if (project && row.unread) counts.set(project, (counts.get(project) ?? 0) + 1);
  }
  return counts;
}

/** Every row any inbox read of this project holds, so a filtered list still offers the rest. */
function seenRows(cache: QueryClient, project: string | undefined): ForgeInboxRow[] {
  return cache
    .getQueriesData<ForgeInboxList>({ queryKey: inboxKey(project) })
    .flatMap(([, data]) => data?.items ?? []);
}

/**
 * The person's GitHub notifications across the main column: review requests, mentions,
 * assignments, replies and CI, newest first. Pull requests and issues open as ace's own pages;
 * everything else opens on GitHub. Opening a row marks it read.
 */
export function InboxPage(props: {
  search: InboxSearch;
  onSearch(patch: Partial<InboxSearch>): void;
}) {
  const { search, onSearch } = props;
  const choice = useProjectChoice(search);
  // Notifications are the account's: one read, through the first project, for every choice.
  const project = choice.all[0];
  const repositories = useProjectRepositories(choice.all);
  const projectOf = inboxProjects(repositories);
  const listKey = JSON.stringify([project, search.view, search.only, search.repo]);
  const [paging, setPaging] = useState({ key: listKey, pages: 1 });
  const pages = paging.key === listKey ? paging.pages : 1;
  const read = useInboxPages(project, search, pages);
  const list = { ...read, rows: rowsForProjects(read.rows, choice.picked, projectOf) };
  const writes = useInboxWrites(project);
  // The unfiltered first page the sidebar polls: shared with it, and it keeps the filters'
  // choices whole. With a filter on, the page therefore polls twice: the filtered list and this.
  const everything = useInboxPages(project, {}, 1);
  const cache = useQueryClient();
  const toast = useToast();
  const openWeb = useOpenWebAddress();
  const clock = useClock();
  const listAddress = useLocation({ select: (location) => location.searchStr });
  const ownRepository = list.first?.projectRepository ?? everything.first?.projectRepository;
  const own = ownRepository ? repositoryParam(ownRepository) : undefined;
  const groups = inboxGroups(list.rows);
  // Triage from the keyboard: e marks done, m mutes (unsubscribes, which also clears it).
  const triage = (row: ForgeInboxRow, action: "read" | "done" | "unsubscribe") =>
    void (async () => {
      const sent = await writes.write({ action, id: row.id });
      if (sent && action === "unsubscribe") await writes.write({ action: "done", id: row.id });
    })();
  const allRows = list.first?.items ?? [];
  const filtered = !!(search.reason || search.repo || search.only);
  const unread = list.rows.some((row) => row.unread);
  /**
   * GitHub can mark everything read, or one repository's; it can't mark only participating
   * threads, one reason's or some projects', so then the rows on show are marked one by one.
   */
  const readAll = async () => {
    if (!search.only && !search.reason && !choice.picked.length)
      return writes.readAll(search.repo, clock());
    for (const row of list.rows)
      if (row.unread && !(await writes.write({ action: "read", id: row.id }))) return false;
    return true;
  };
  const open = (url: string) =>
    void openWeb(url).catch(() => toast.error({ title: "Couldn't open GitHub" }));
  const frame = (
    <ListFrame
      kind="inbox"
      address={listAddress}
      ready={list.rows.length > 0}
      lead={
        <ProjectMenu
          choice={choice}
          counts={unreadCounts(read.rows, projectOf, choice.all)}
          onPick={(next) => onSearch(choice.pick(next))}
        />
      }
      footer={list.rows.length > 0 && writes.ready ? <TriageKeys /> : null}
      strip={
        // The rows on show are an earlier answer: say so once, with the way to ask again.
        list.error && list.first ? (
          <div
            role="status"
            aria-label="Inbox refresh"
            className="flex min-h-9 min-w-0 items-center gap-1 border-t border-border py-1 text-ui text-muted-foreground"
          >
            <span className="min-w-0 truncate" title={list.error.message}>
              Couldn't refresh notifications.
            </span>
            <Button size="xs" variant="ghost" className="text-foreground" onClick={list.retry}>
              Try again
            </Button>
          </div>
        ) : null
      }
      actions={
        unread && writes.ready ? (
          <Button size="sm" onClick={() => void readAll()}>
            Mark all read
          </Button>
        ) : null
      }
      menus={
        <>
          <FilterMenu
            label="Read state"
            value={search.view ?? "unread"}
            options={[
              { value: "unread" as const, label: "Unread" },
              { value: "all" as const, label: "All" },
            ]}
            onValueChange={(view) => onSearch({ view: view === "all" ? "all" : undefined })}
          />
          <FiltersMenu
            sections={[
              {
                kind: "one",
                id: "only",
                label: "Involvement",
                value: search.only ?? "",
                choices: [
                  { value: "", label: "Everything" },
                  { value: "participating", label: "Participating" },
                ],
                onChange: (value) =>
                  onSearch({ only: value === "participating" ? "participating" : undefined }),
              },
              {
                kind: "one",
                id: "reason",
                label: "Reason",
                value: search.reason ?? "",
                choices: [
                  { value: "", label: "Any reason" },
                  ...reasonChoices([...everything.rows, ...allRows], search.reason),
                ],
                onChange: (value) => onSearch({ reason: value || undefined }),
              },
              {
                kind: "one",
                id: "repository",
                label: "Repository",
                value: search.repo ?? "",
                choices: [
                  { value: "", label: "Every repository" },
                  ...repositoryChoices(
                    [...everything.rows, ...seenRows(cache, project)],
                    search.repo,
                  ),
                ],
                onChange: (value) => onSearch({ repo: value || undefined }),
              },
            ]}
            onClear={() => onSearch({ only: undefined, reason: undefined, repo: undefined })}
          />
        </>
      }
    >
      {!project ? (
        choice.loaded && (
          <EmptyState
            title="No projects yet"
            description="Add a project with a GitHub remote to see your notifications."
          />
        )
      ) : list.error && !list.first ? (
        <EmptyState
          title="Couldn't load notifications"
          description={list.error.message}
          action={
            <Button size="sm" onClick={list.retry}>
              Try again
            </Button>
          }
        />
      ) : list.loading ? (
        <RowsSkeleton kind="issues" />
      ) : !list.rows.length ? (
        filtered ? (
          <EmptyState title="No notifications match" />
        ) : search.view === "all" ? (
          <EmptyState title="No notifications" />
        ) : (
          <EmptyState
            title="No unread notifications"
            action={
              <Button size="sm" onClick={() => onSearch({ view: "all" })}>
                Show all
              </Button>
            }
          />
        )
      ) : (
        <ForgeList
          label="Notifications"
          stale={list.stale}
          groups={groups.map((group) => ({
            id: group.id,
            label: group.label,
            icon: groupIcons[group.id as keyof typeof groupIcons] ?? BellIcon,
            count: countWords(group.rows.length, undefined, !list.more),
            headed: true,
            rows: group.rows,
          }))}
          rowKey={(row) => row.id}
          rowTitle={(row) => row.title}
          estimate={61}
          onRowKey={(row, key) => {
            if (!writes.ready || (key !== "e" && key !== "m")) return false;
            triage(row, key === "e" ? "done" : "unsubscribe");
            return true;
          }}
          renderRow={(row, _group, last) => {
            const repo = repositoryParam(row.repository);
            const owner = projectOf(row);
            return (
              <InboxRow
                row={row}
                tag={owner && !choice.one ? { id: owner, name: choice.name(owner) } : undefined}
                to={{
                  project: owner ?? project,
                  repo: owner || repo.toLowerCase() === own?.toLowerCase() ? undefined : repo,
                  back: `/inbox${listAddress}`,
                }}
                onOpenWeb={open}
                onWrite={(action) => triage(row, action)}
                last={last}
              />
            );
          }}
          onMore={list.more ? () => setPaging({ key: listKey, pages: pages + 1 }) : undefined}
        />
      )}
    </ListFrame>
  );
  return (
    <Screen title="Inbox" namedByPanel>
      {frame}
    </Screen>
  );
}
