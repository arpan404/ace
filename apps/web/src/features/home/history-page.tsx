import { useSidebarLoaded } from "@ace/client-react";
import { ChatCircleIcon } from "@ace/icons";
import { historySections, projectBadge, type HistoryItem } from "@ace/ui-core";
import { useEffect, useMemo, useRef, useState } from "react";
import { SearchField } from "@/components/search-field.tsx";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useViewListKeys } from "@/components/ui/view-row.tsx";
import { VirtualList, type VirtualRowsHandle } from "@/components/virtual-rows.tsx";
import { useOrganizerState, useWindowThreads } from "@/features/organize/index.ts";
import { Screen } from "@/features/shell/index.ts";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { useHeld } from "@/lib/held.ts";
import { useProjectDirectory, useProjectName } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";
import { HistoryRow } from "./history-row.tsx";
import { ProjectMark } from "./row-parts.tsx";
import { settledFoot, useSettledPaging } from "./settled-paging.ts";
import { useSidebarDevice } from "./device-filter-state.ts";
import { useHomeList, useProjects, useSettledEntries } from "./use-home-threads.ts";
import { useSettledSearch } from "./use-panel-search.ts";

/** One row of History's list: a section's heading, or a settled thread under it. */
type HistoryEntry =
  | { kind: "label"; label: string; group: string; first: boolean }
  | { kind: "thread"; item: HistoryItem };

/**
 * A heading is 16px of words with 2px below and 12px above (24px between sections); a thread is
 * two lines in 8px of padding.
 */
const estimateOf = (entry: HistoryEntry) => (entry.kind === "thread" ? 58 : entry.first ? 30 : 42);

/** The full pages' one gutter (DESIGN.md §3, Full pages): 16px in a narrow column, 32px beside it. */
const gutter = "[--forge-gutter:1rem] sm:[--forge-gutter:2rem]";

/** The filter's values that name no project: every one, or every chat (each chat has its own). */
const allProjects = "\u0000all";
const chatsProject = "chats";

/**
 * History: every settled thread, newest first under This week, Last week and Earlier, with a
 * search (titles, projects, branches and PRs of the loaded ones; the daemon's search for older
 * ones) and a chip per project. Older settled threads page in from the daemon as the list
 * scrolls to its end. Each row opens its thread.
 */
export function HistoryPage(props: { project: string | undefined; onProject(id?: string): void }) {
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const list = useHomeList(undefined, query);
  const loaded = useSettledEntries(list.settled);
  const search = useSettledSearch(query, list, loaded);
  const sidebarLoaded = useSidebarLoaded();
  const skeleton = useHeld(!sidebarLoaded);
  const now = useNow();
  const projectName = useProjectName();
  const isChat = useProjectDirectory().isChat;
  const filter = useOrganizerState().project;
  const paging = useSettledPaging(filter, useSidebarDevice());
  const foot = settledFoot(paging);
  const found: readonly HistoryItem[] = searching ? search.matches : loaded;
  // Every chat has its own hidden project, so one "Chats" choice takes all of them.
  const items = useMemo(
    () =>
      props.project === chatsProject ? found.filter((item) => isChat(item.project)) : found,
    [found, props.project, isChat],
  );
  const sections = useMemo(
    () =>
      historySections(items, {
        project: props.project === chatsProject ? null : (props.project ?? null),
        now,
      }),
    [items, props.project, now],
  );
  const entries = useMemo(() => {
    const rows: HistoryEntry[] = [];
    for (const section of sections) {
      rows.push({
        kind: "label",
        label: section.label,
        group: section.group,
        first: !rows.length,
      });
      for (const item of section.items) rows.push({ kind: "thread", item });
    }
    return rows;
  }, [sections]);
  const threads = useWindowThreads();
  const handle = useRef<VirtualRowsHandle>(null);
  const keys = useViewListKeys<HTMLDivElement>({
    count: entries.length,
    titleAt: (index) => {
      const entry = entries[index];
      if (entry?.kind !== "thread") return undefined;
      const { id } = entry.item;
      return threads.entry(id)?.title ?? search.hits.get(id)?.threadTitle ?? "";
    },
    reveal: (index) => handle.current?.scrollToIndex(index, "auto"),
  });
  const end = useRef<HTMLDivElement>(null);
  const { more } = paging;
  // The list's end in sight asks for the next page. Each page passes through loading, so the
  // observer starts over after it and asks again while the end is still in sight.
  useEffect(() => {
    const element = end.current;
    if (!element || foot !== "more") return;
    // Without an observer (an old engine), every page loads in turn.
    if (typeof IntersectionObserver === "undefined") return void more();
    const observer = new IntersectionObserver((seen) => {
      if (seen.some((each) => each.isIntersecting)) void more();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [foot, more]);
  return (
    <Screen page="history" title="History">
      <div {...part("scrollbar")} className={cn("h-full overflow-y-auto", gutter)}>
        <div
          {...part("page-body")}
          className="mx-auto flex w-full max-w-[720px] flex-col gap-3 px-(--forge-gutter) pt-6 pb-10"
        >
          {/* The header names the page (h1); this is its title over the list. */}
          <h2 {...part("page-title")} className="text-xl font-semibold text-foreground">
            History
          </h2>
          <SearchField
            label="Search history"
            placeholder="Search settled threads, PRs, branches"
            value={query}
            onValueChange={setQuery}
          />
          <HistoryProjectFilter project={props.project} onProject={props.onProject} />
          {!sidebarLoaded ? (
            skeleton && <ListSkeleton label="settled threads" shape="row" />
          ) : sections.length === 0 && foot === undefined ? (
            <p className="py-6 text-ui text-muted-foreground">
              {searching
                ? `Nothing settled matches “${query.trim()}”.`
                : props.project === chatsProject
                  ? "No settled chats yet."
                  : props.project
                    ? `No settled threads in ${projectName(props.project)}.`
                    : "No settled threads yet."}
            </p>
          ) : (
            <div {...part("list")} {...keys}>
              <VirtualList
                label="Settled threads"
                items={entries}
                handle={handle}
                rowKey={(entry) =>
                  entry.kind === "label" ? `label:${entry.group}` : entry.item.id
                }
                estimate={estimateOf}
                render={(entry) =>
                  entry.kind === "label" ? (
                    <h3
                      className={cn(
                        "pb-0.5 text-xs font-medium text-subtle-foreground",
                        entry.first ? "pt-3" : "pt-6",
                      )}
                    >
                      {entry.label}
                    </h3>
                  ) : (
                    <HistoryRow
                      id={entry.item.id}
                      at={entry.item.at}
                      hit={search.hits.get(entry.item.id)}
                    />
                  )
                }
              />
            </div>
          )}
          <div ref={end} className="h-px" />
          {foot === "loading" && (
            <p role="status" className="text-ui text-subtle-foreground">
              Loading older threads…
            </p>
          )}
          {foot === "error" && (
            <button
              type="button"
              onClick={() => void more()}
              className="self-start rounded-md text-ui text-muted-foreground hover:text-foreground focus-ring"
            >
              Couldn’t load older threads. Retry
            </button>
          )}
        </div>
      </div>
    </Screen>
  );
}

/**
 * One project menu: every project with settled threads, plus one "Chats" choice for the chats'
 * own hidden projects (ADR 0099), which would otherwise list as a row of identical "Chat" chips.
 */
function HistoryProjectFilter(props: { project: string | undefined; onProject(id?: string): void }) {
  const counts = useProjects();
  const name = useProjectName();
  const isChat = useProjectDirectory().isChat;
  const chats = counts.filter((each) => isChat(each.id));
  const ids = counts.flatMap((each) => (isChat(each.id) ? [] : [each.id]));
  if (
    props.project !== undefined &&
    props.project !== chatsProject &&
    !ids.includes(props.project)
  ) {
    ids.push(props.project);
  }
  ids.sort((a, b) => name(a).localeCompare(name(b)) || a.localeCompare(b));
  const total = counts.reduce((sum, each) => sum + each.threads, 0);
  const chatThreads = chats.reduce((sum, each) => sum + each.threads, 0);
  const options = [
    { value: allProjects, label: "All projects", count: total },
    ...(chatThreads > 0 || props.project === chatsProject
      ? [
          {
            value: chatsProject,
            label: "Chats",
            count: chatThreads,
            icon: <ChatCircleIcon aria-hidden size={16} className="text-muted-foreground" />,
          },
        ]
      : []),
    ...ids.map((id) => ({
      value: id,
      label: name(id),
      count: counts.find((each) => each.id === id)?.threads ?? 0,
      icon: <ProjectMark id={id} badge={projectBadge({ id, name: name(id) })} />,
    })),
  ];
  return (
    <div {...part("filter-bar")} className="-ml-2">
      <FilterMenu
        label="Project"
        value={props.project ?? allProjects}
        options={options}
        align="start"
        onValueChange={(value) =>
          props.onProject(
            value === allProjects ? undefined : value === chatsProject ? chatsProject : value,
          )
        }
      />
    </div>
  );
}
