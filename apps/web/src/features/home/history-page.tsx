import { useSidebarLoaded } from "@ace/client-react";
import { historySections, projectBadge, type HistoryItem } from "@ace/ui-core";
import { useEffect, useMemo, useRef, useState } from "react";
import { SearchField } from "@/components/search-field.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useOrganizerState } from "@/features/organize/index.ts";
import { Screen } from "@/features/shell/index.ts";
import { cn } from "@/lib/cn.ts";
import { useHeld } from "@/lib/held.ts";
import { useProjectName } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";
import { HistoryRow } from "./history-row.tsx";
import { ProjectMark } from "./row-parts.tsx";
import { settledFoot, useSettledPaging } from "./settled-paging.ts";
import { useSidebarDevice } from "./device-filter-state.ts";
import { useHomeList, useProjects, useSettledEntries } from "./use-home-threads.ts";
import { useSettledSearch } from "./use-panel-search.ts";

/** The full pages' one gutter (DESIGN.md §3, Full pages): 16px in a narrow column, 32px beside it. */
const gutter = "[--forge-gutter:1rem] sm:[--forge-gutter:2rem]";

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
  const filter = useOrganizerState().project;
  const paging = useSettledPaging(filter, useSidebarDevice());
  const foot = settledFoot(paging);
  const items: readonly HistoryItem[] = searching ? search.matches : loaded;
  const sections = useMemo(
    () => historySections(items, { project: props.project ?? null, now }),
    [items, props.project, now],
  );
  const end = useRef<HTMLDivElement>(null);
  const { more } = paging;
  // The list's end in sight asks for the next page. Each page passes through loading, so the
  // observer starts over after it and asks again while the end is still in sight.
  useEffect(() => {
    const element = end.current;
    if (!element || foot !== "more" || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((seen) => {
      if (seen.some((each) => each.isIntersecting)) void more();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [foot, more]);
  return (
    <Screen title="History">
      <div className={cn("h-full overflow-y-auto", gutter)}>
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3 px-(--forge-gutter) pt-6 pb-10">
          {/* The header names the page (h1); this is its title over the list. */}
          <h2 className="text-xl font-semibold text-foreground">History</h2>
          <SearchField
            label="Search history"
            placeholder="Search settled threads, PRs, branches"
            value={query}
            onValueChange={setQuery}
          />
          <ProjectChips project={props.project} onProject={props.onProject} />
          {!sidebarLoaded ? (
            skeleton && <ListSkeleton label="settled threads" shape="row" />
          ) : sections.length === 0 && foot === undefined ? (
            <p className="py-6 text-ui text-muted-foreground">
              {searching
                ? `Nothing settled matches “${query.trim()}”.`
                : props.project
                  ? `No settled threads in ${projectName(props.project)}.`
                  : "No settled threads yet."}
            </p>
          ) : (
            sections.map((section) => (
              <section key={section.group} aria-label={section.label}>
                <h3 className="mt-3 mb-0.5 text-xs font-medium text-subtle-foreground">
                  {section.label}
                </h3>
                <ul className="flex flex-col">
                  {section.items.map((item) => (
                    <HistoryRow
                      key={item.id}
                      id={item.id}
                      at={item.at}
                      hit={search.hits.get(item.id)}
                    />
                  ))}
                </ul>
              </section>
            ))
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

const chip = (selected: boolean) =>
  cn(
    "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-ui transition-colors duration-(--motion-fast) focus-ring",
    selected
      ? "bg-active font-medium text-foreground"
      : "text-muted-foreground hover:bg-hover hover:text-foreground",
  );

/** All projects, then one chip per project with threads; the chosen one on the active fill. */
function ProjectChips(props: { project: string | undefined; onProject(id?: string): void }) {
  const projects = useProjects();
  const name = useProjectName();
  const ids = projects.map((each) => each.id);
  if (props.project !== undefined && !ids.includes(props.project)) ids.push(props.project);
  return (
    <div role="group" aria-label="Project" className="-mx-3 flex flex-wrap gap-1">
      <button
        type="button"
        aria-pressed={props.project === undefined}
        onClick={() => props.onProject(undefined)}
        className={chip(props.project === undefined)}
      >
        All projects
      </button>
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          aria-pressed={props.project === id}
          onClick={() => props.onProject(id)}
          className={chip(props.project === id)}
        >
          <ProjectMark id={id} badge={projectBadge({ id, name: name(id) })} />
          {name(id)}
        </button>
      ))}
    </div>
  );
}
