import { useState } from "react";
import { useLocation } from "@tanstack/react-router";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { ForgeInboxList, ForgeInboxRow, ForgeIssueList, ForgePrList } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { WordChoice } from "@/components/ui/word-choice.tsx";
import { useViewListKeys } from "@/components/ui/view-row.tsx";
import { useOpenWebAddress } from "@/components/web-link.tsx";
import { Screen } from "@/features/shell/index.ts";
import { cn } from "@/lib/cn.ts";
import { repositoryParam } from "@/lib/pull-request-route.ts";
import { useNow } from "@/lib/time.ts";
import { FiltersMenu } from "./filters-menu.tsx";
import { inboxKey, useInboxPages, useInboxWrites } from "./inbox-data.ts";
import { reasonChoices, repositoryChoices, type InboxSearch } from "./inbox-model.ts";
import { InboxRow } from "./inbox-row.tsx";
import { ListFrame, ToolbarRule } from "./list-frame.tsx";
import { RowsSkeleton } from "./list-skeletons.tsx";
import { useProjectChoice } from "./project-choice.ts";

/** The project's own repository, as a list already read for it says; `repo` names others. */
function ownRepository(cache: QueryClient, project: string): string | undefined {
  for (const kind of ["prList", "issueList"] as const)
    for (const [, data] of cache.getQueriesData<ForgePrList | ForgeIssueList>({
      queryKey: ["forge", project, "browse", kind],
    }))
      if (data?.repository) return repositoryParam(data.repository);
  return undefined;
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
  const choice = useProjectChoice(search.project);
  const project = choice.project;
  const listKey = JSON.stringify([project, search.view, search.only, search.repo]);
  const [paging, setPaging] = useState({ key: listKey, pages: 1 });
  const pages = paging.key === listKey ? paging.pages : 1;
  const list = useInboxPages(project, search, pages);
  const writes = useInboxWrites(project);
  // The unfiltered first page the sidebar polls: shared, and it keeps the filters' choices whole.
  const everything = useInboxPages(project, {}, 1);
  const keys = useViewListKeys<HTMLElement>();
  const cache = useQueryClient();
  const toast = useToast();
  const openWeb = useOpenWebAddress();
  const now = useNow();
  const listAddress = useLocation({ select: (location) => location.searchStr });
  const own = project ? ownRepository(cache, project) : undefined;
  const allRows = list.first?.items ?? [];
  const filtered = !!(search.reason || search.repo || search.only);
  const unread = list.rows.some((row) => row.unread);
  /**
   * GitHub can mark everything read, or one repository's; it can't mark only participating
   * threads or one reason's, so then the rows on show are marked one by one.
   */
  const readAll = async () => {
    if (!search.only && !search.reason) return writes.readAll(search.repo, now);
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
      actions={
        unread && writes.ready ? (
          <Button size="sm" onClick={() => void readAll()}>
            Mark all read
          </Button>
        ) : null
      }
      controls={
        <>
          <WordChoice
            label="Read state"
            value={search.view ?? "unread"}
            options={[
              { value: "unread" as const, label: "Unread" },
              { value: "all" as const, label: "All" },
            ]}
            onValueChange={(view) => onSearch({ view: view === "all" ? "all" : undefined })}
          />
          <ToolbarRule />
          <WordChoice
            label="Involvement"
            value={search.only ?? "everything"}
            options={[
              { value: "everything" as const, label: "Everything" },
              { value: "participating" as const, label: "Participating" },
            ]}
            onValueChange={(only) =>
              onSearch({ only: only === "participating" ? "participating" : undefined })
            }
          />
        </>
      }
      menus={
        <FiltersMenu
          sections={[
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
          onClear={() => onSearch({ reason: undefined, repo: undefined })}
        />
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
        <nav
          aria-label="Notifications"
          aria-busy={list.stale}
          {...keys}
          className={cn(
            "pb-6",
            list.stale && "opacity-60 transition-opacity duration-(--motion-fast)",
          )}
        >
          <ul>
            {list.rows.map((row) => {
              const repo = repositoryParam(row.repository);
              return (
                <InboxRow
                  key={row.id}
                  row={row}
                  to={{
                    project,
                    repo: repo.toLowerCase() === own?.toLowerCase() ? undefined : repo,
                    back: `/inbox${listAddress}`,
                  }}
                  onOpenWeb={open}
                  onWrite={(action) =>
                    void (async () => {
                      // Unsubscribing also clears the thread from the inbox, as on GitHub.
                      const sent = await writes.write({ action, id: row.id });
                      if (sent && action === "unsubscribe")
                        await writes.write({ action: "done", id: row.id });
                    })()
                  }
                />
              );
            })}
          </ul>
          {list.more && (
            <div className="px-(--forge-gutter) pt-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPaging({ key: listKey, pages: pages + 1 })}
              >
                Show more
              </Button>
            </div>
          )}
        </nav>
      )}
    </ListFrame>
  );
  return <Screen title="Inbox">{frame}</Screen>;
}
