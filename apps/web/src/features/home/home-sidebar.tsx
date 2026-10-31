import { ChatsIcon, NotePencilIcon } from "@phosphor-icons/react";
import { useSidebar, useSidebarLoaded } from "@ace/client-react";
import { settledTotal as settledCount } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { Suspense, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { PaletteButton, PanelHeader } from "@/features/shell/index.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { useNewThreadEntry } from "@/features/projects/index.ts";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useHeld } from "@/lib/held.ts";
import { useHostIdentity } from "@/lib/host-name.ts";
import { useMachineEntries } from "@/lib/machine-threads.ts";
import { useProjectDirectory } from "@/lib/projects.ts";
import { useResolvedKeymap } from "@/lib/keybindings.ts";
import { formatKeys } from "@/lib/keymap.ts";
import { ThreadsActions } from "./project-filter.tsx";
import { ThreadList } from "./thread-list.tsx";
import { useSidebarDevice } from "./device-filter-state.ts";
import { useMachines } from "@/lib/machines.ts";
import { useThreadsWindowSync } from "./thread-pagination.tsx";
import { useHomeList, useSettledEntries } from "./use-home-threads.ts";
import { PanelSearch, PanelTabs, SettledChips } from "./panel-header.tsx";
import { useSettledPaging } from "./settled-paging.ts";
import { useSettledSearch } from "./use-panel-search.ts";
import { rowFocusSelector } from "./list-focus.ts";
import type { PanelView } from "./thread-list.tsx";
import {
  useOrganizer,
  useOrganizerState,
  useOverlaidMachineEntries,
} from "@/features/organize/index.ts";

/** Publish provisional titles even while the Unsent section is outside the virtual window. */
const StartedTitlePublisher = deferredComponent(() =>
  import("./started-rows.tsx").then((module) => module.StartedTitlePublisher),
);

/**
 * The Threads panel: its title with the filter and New thread, a search over every thread, and
 * two tabs. Active lists the work in hand across projects (Pinned, Needs you, Running, then by
 * day, with Snoozed folded at the foot); Settled lists settled threads by week, narrowed by
 * project chips, loading older ones as the person scrolls. Searching narrows Active at once and
 * lists the settled matches, the daemon's included, under their own heading.
 */
export function HomeSidebar() {
  // Other machines' threads join the list, each row marked with its machine.
  const host = useHostIdentity()?.hostId;
  const others = useOverlaidMachineEntries(useMachineEntries(host));
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const list = useHomeList(others, query);
  // The daemon's count of settled threads, while it still holds some back.
  const settledTotal = useSidebar(["homeWindow"], (reader) => settledCount(reader.homeWindow));
  const { project, homeTab: tab } = useOrganizerState();
  const device = useSidebarDevice();
  const deviceName = useMachines().find((machine) => machine.id === device)?.name;
  useThreadsWindowSync();
  const organizer = useOrganizer();
  const loaded = useSidebarLoaded();
  // A filter switch usually paints at once (remembered or derived rows): never flash a skeleton.
  const skeleton = useHeld(!loaded);
  const loadedSettled = useSettledEntries(list.settled);
  const search = useSettledSearch(query, list, loadedSettled);
  const paging = useSettledPaging(project, device);
  const [chip, setChip] = useState<string | null>(null);
  const settled = searching ? search.matches : loadedSettled;
  const name = useProjectDirectory().name;
  const chips = useMemo(() => {
    const ids = new Set(settled.map((item) => item.project));
    if (chip !== null) ids.add(chip);
    return [...ids].toSorted((a, b) => name(a).localeCompare(name(b)));
  }, [settled, chip, name]);
  // The panel's project filter already narrows Settled: chips only add to it when it is off.
  const shownChip = project === null ? chip : null;
  const settledItems = useMemo(
    () => (shownChip === null ? settled : settled.filter((item) => item.project === shownChip)),
    [settled, shownChip],
  );
  const ownSettled = !device || device === host;
  const counts = {
    active: list.pinned.length + list.listed.length,
    settled: searching
      ? settled.length
      : Math.max(list.settled.length, (ownSettled && settledTotal) || 0),
  };
  const nav = useRef<HTMLElement>(null);
  const empty =
    !searching &&
    [list.pinned, list.listed, list.snoozed, list.settled].every((ids) => !ids.length) &&
    !settledTotal;
  const directory = useProjectDirectory();
  const keys = useResolvedKeymap();
  const entry = useNewThreadEntry();
  const { only } = entry;
  const view: PanelView =
    tab === "settled"
      ? {
          tab: "settled",
          items: settledItems,
          foot: paging.loading ? "loading" : paging.error ? "error" : undefined,
          onNearEnd: () => void paging.more(),
          onRetry: () => void paging.more(),
        }
      : {
          tab: "active",
          searching,
          settledMatches: searching ? search.matches.map((item) => item.id) : undefined,
        };
  const nothing = searching
    ? tab === "settled"
      ? !settledItems.length
      : !counts.active && !list.snoozed.length && !search.matches.length
    : tab === "settled"
      ? !settledItems.length && !paging.loading
      : !counts.active && !list.snoozed.length;
  return (
    <>
      <PanelHeader
        title="Threads"
        className="@container/thread-filters"
        actions={
          <>
            <ThreadsActions />
            <PaletteButton />
            <Tip label="New thread" shortcut="newThread">
              <Link
                to="/new"
                {...(only ? { search: { project: only } } : {})}
                aria-label="New thread"
                className="relative grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground focus-ring touch-hit touch-hit-lg hover:bg-sidebar-accent hover:text-foreground"
                onClick={(event) => {
                  // Shift skips the question (the current project); several projects ask which.
                  if (event.shiftKey) {
                    event.preventDefault();
                    entry.here();
                  } else if (!only) {
                    event.preventDefault();
                    entry.start();
                  }
                }}
              >
                <Icon icon={NotePencilIcon} />
              </Link>
            </Tip>
          </>
        }
      />
      <PanelSearch
        value={query}
        onChange={setQuery}
        onEnterList={() => nav.current?.querySelector<HTMLElement>(rowFocusSelector)?.focus()}
      />
      <PanelTabs
        tab={tab}
        active={counts.active}
        settled={counts.settled}
        onChange={(next) => organizer.setHomeTab(next)}
      />
      {tab === "settled" && (
        <SettledChips
          projects={project === null ? chips : []}
          value={shownChip}
          onChange={setChip}
        />
      )}
      <nav ref={nav} aria-label="Threads" className="flex min-h-0 flex-1 flex-col">
        {loaded && (
          <Suspense fallback={null}>
            <StartedTitlePublisher.Component />
          </Suspense>
        )}
        {!loaded ? (
          skeleton && <ListSkeleton label="threads" shape="thread" />
        ) : empty ? (
          <>
            <EmptyState
              className="shrink-0 justify-start pt-6"
              icon={ChatsIcon}
              title={
                project
                  ? `Nothing in ${directory.name(project)}`
                  : deviceName
                    ? `No threads on ${deviceName}`
                    : "No threads yet"
              }
              description={
                project
                  ? "Threads from this project will land here."
                  : deviceName
                    ? "Threads from this device will land here."
                    : `Start one${keys.newThread ? ` with ${formatKeys(keys.newThread)}` : ""}. Threads from every project and machine land here.`
              }
              action={
                project ? (
                  <button
                    type="button"
                    className="text-ui font-medium text-foreground underline-offset-4 hover:underline"
                    onClick={() => organizer.setProject(null)}
                  >
                    Show all projects
                  </button>
                ) : device ? (
                  <button
                    type="button"
                    className="text-ui font-medium text-foreground underline-offset-4 hover:underline"
                    onClick={() => organizer.setDevice(undefined)}
                  >
                    Show all devices
                  </button>
                ) : undefined
              }
            />
            <ThreadList list={list} />
          </>
        ) : (
          <>
            {nothing && (
              <p role="status" className="shrink-0 px-4 pt-3 text-ui text-subtle-foreground">
                {searching
                  ? `Nothing matches “${query.trim()}”.`
                  : tab === "settled"
                    ? "No settled threads here."
                    : "Nothing active. Settled threads are under Settled."}
              </p>
            )}
            <ThreadList
              list={list}
              view={view}
              hits={search.hits}
              resetKey={`${tab}\u0000${query.trim()}`}
            />
          </>
        )}
      </nav>
    </>
  );
}
