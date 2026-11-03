import { useState } from "react";
import { CaretDownIcon } from "@phosphor-icons/react";
import { useLocation } from "@tanstack/react-router";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { ForgeInboxList, ForgeInboxRow } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useOpenWebAddress } from "@/components/web-link.tsx";
import { Screen } from "@/features/shell/index.ts";
import { repositoryParam } from "@/lib/pull-request-route.ts";
import { useClock } from "@/lib/time.ts";
import { ForgeList } from "./forge-list.tsx";
import { inboxKey, useInboxPages, useInboxWrites } from "./inbox-data.ts";
import {
  inboxGroups,
  inboxProjects,
  repositoryCounts,
  rowsForProjects,
  type InboxSearch,
} from "./inbox-model.ts";
import { useProjectRepositories } from "./inbox-projects.ts";
import { InboxRow } from "./inbox-row.tsx";
import { InboxSide } from "./inbox-side.tsx";
import { ListFrame } from "./list-frame.tsx";
import { RowsSkeleton } from "./list-skeletons.tsx";
import { useProjectChoice } from "./project-choice.ts";
import { ProjectMenu } from "./project-menu.tsx";
import { QueryField } from "./query-field.tsx";
import { inboxQueryText, inboxSearchOf } from "./query-text.ts";
import { countWords, StateToggles } from "./quick-views.tsx";
import { TriageKeys } from "./triage-keys.tsx";

type Write = "read" | "done" | "unsubscribe";

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

const groupWords = { date: "Date", repo: "Repository" } as const;

/** GitHub's "Group by: Date ⌄" choice over the rows. */
function GroupBy(props: { value: "date" | "repo"; onValue(value: "date" | "repo"): void }) {
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Group by: ${groupWords[props.value]}`}
        className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2.5 text-ui text-foreground focus-ring transition-colors duration-(--motion-fast) hover:bg-hover aria-expanded:bg-hover"
      >
        <span className="text-muted-foreground">Group by:</span>
        <span className="font-medium">{groupWords[props.value]}</span>
        <CaretDownIcon aria-hidden size={12} className="text-muted-foreground" />
      </MenuTrigger>
      <MenuContent aria-label="Group by" align="end" className="min-w-40">
        <MenuRadioGroup
          value={props.value}
          onValueChange={(value: unknown) => props.onValue(value === "repo" ? "repo" : "date")}
        >
          <MenuRadioItem value="date">Date</MenuRadioItem>
          <MenuRadioItem value="repo">Repository</MenuRadioItem>
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

/**
 * The person's GitHub notifications, laid out as GitHub's own inbox: the filter column on the
 * left; the filter line and Group by over one box whose header selects rows for Mark as read,
 * Mark as done and Unsubscribe. Pull requests and issues open as ace's own pages; everything
 * else opens on GitHub. Opening a row marks it read. j/k move, e marks done, m unsubscribes.
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
  const groupBy = search.group ?? "date";
  const groups = inboxGroups(list.rows, groupBy, clock());
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const selected = list.rows.filter((row) => picked.has(row.id));
  const triage = (row: ForgeInboxRow, action: Write) =>
    void (async () => {
      const sent = await writes.write({ action, id: row.id });
      if (sent && action === "unsubscribe") await writes.write({ action: "done", id: row.id });
    })();
  const bulk = (action: Write) => {
    for (const row of selected) if (action !== "read" || row.unread) triage(row, action);
    setPicked(new Set());
  };
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
  const known = [...everything.rows, ...seenRows(cache, project)];
  const unreadEverywhere = rowsForProjects(everything.rows, choice.picked, projectOf).filter(
    (row) => row.unread,
  ).length;
  const bar = (
    <>
      <StateToggles
        label="Views"
        value={search.view ?? "unread"}
        onValue={(view) => onSearch({ view: view === "all" ? "all" : undefined })}
        views={[
          { id: "all", label: "All", count: undefined },
          {
            id: "unread",
            label: "Unread",
            count: countWords(unreadEverywhere, undefined, !everything.more),
          },
        ]}
      />
      <QueryField
        label="Filter notifications"
        placeholder="Filter notifications"
        value={inboxQueryText(search)}
        lineOf={(text) =>
          inboxQueryText({
            ...search,
            ...inboxSearchOf(
              text,
              known.map((row) => repositoryParam(row.repository)),
            ),
          })
        }
        settles={() => false}
        onApply={(text) =>
          onSearch(
            inboxSearchOf(
              text,
              known.map((row) => repositoryParam(row.repository)),
            ),
          )
        }
      />
      <GroupBy
        value={groupBy}
        onValue={(next) => onSearch({ group: next === "repo" ? "repo" : undefined })}
      />
      <ProjectMenu
        choice={choice}
        counts={unreadCounts(read.rows, projectOf, choice.all)}
        onPick={(next) => onSearch(choice.pick(next))}
      />
    </>
  );
  const all = list.rows.length > 0 && selected.length === list.rows.length;
  const header = (
    <>
      <span className="flex h-8 items-center gap-3 pl-2">
        <Checkbox
          aria-label="Select all"
          checked={all}
          indeterminate={selected.length > 0 && !all}
          disabled={!list.rows.length || !writes.ready}
          onCheckedChange={(checked: boolean) =>
            setPicked(new Set(checked ? list.rows.map((row) => row.id) : []))
          }
        />
        <span className="text-ui text-muted-foreground">
          {selected.length ? `${selected.length} selected` : "Select all"}
        </span>
      </span>
      {selected.length > 0 ? (
        <span role="group" aria-label="Selected notifications" className="flex flex-wrap gap-1">
          <Button size="sm" onClick={() => bulk("read")}>
            Mark as read
          </Button>
          <Button size="sm" onClick={() => bulk("done")}>
            Mark as done
          </Button>
          <Button size="sm" onClick={() => bulk("unsubscribe")}>
            Unsubscribe
          </Button>
        </span>
      ) : (
        unread &&
        writes.ready && (
          <Button size="sm" className="ml-auto" onClick={() => void readAll()}>
            Mark all read
          </Button>
        )
      )}
    </>
  );
  return (
    <Screen title="Inbox" namedByPanel>
      <ListFrame
        kind="inbox"
        address={listAddress}
        ready={list.rows.length > 0}
        bar={bar}
        side={
          <InboxSide
            search={search}
            unread={unreadEverywhere}
            repositories={repositoryCounts(known, search.repo)}
            onSearch={onSearch}
          />
        }
        strip={
          // The rows on show are an earlier answer: say so once, with the way to ask again.
          list.error && list.first ? (
            <div
              role="status"
              aria-label="Inbox refresh"
              className="flex min-h-9 min-w-0 items-center gap-1 pt-2 text-ui text-muted-foreground"
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
        header={header}
        footer={list.rows.length > 0 && writes.ready ? <TriageKeys /> : null}
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
          <RowsSkeleton label="notifications" />
        ) : !list.rows.length ? (
          filtered ? (
            <EmptyState title="No notifications match" />
          ) : search.view === "all" ? (
            <EmptyState title="All caught up!" description="Take a break, write some code." />
          ) : (
            <EmptyState
              title="All caught up!"
              description="No unread notifications."
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
            groups={groups}
            rowKey={(row) => row.id}
            rowTitle={(row) => row.title}
            estimate={57}
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
                  to={{
                    project: owner ?? project,
                    repo: owner || repo.toLowerCase() === own?.toLowerCase() ? undefined : repo,
                    back: `/inbox${listAddress}`,
                  }}
                  selected={picked.has(row.id)}
                  onSelect={(on) =>
                    setPicked((current) => {
                      const next = new Set(current);
                      if (on) next.add(row.id);
                      else next.delete(row.id);
                      return next;
                    })
                  }
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
    </Screen>
  );
}
