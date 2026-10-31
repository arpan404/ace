import { ArrowLeftIcon, ChatsIcon, NotePencilIcon } from "@phosphor-icons/react";
import { useSidebarLoaded } from "@ace/client-react";
import type { HomeFocus } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { Suspense, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
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
import { FocusTabs, PanelSearch } from "./panel-header.tsx";
import { useSettledSearch } from "./use-panel-search.ts";
import { rowFocusSelector } from "./list-focus.ts";
import { useHomeFocus } from "./use-home-focus.ts";
import { usePanelRows } from "./use-panel-rows.ts";
import type { SectionActions } from "./tree-rows.tsx";
import {
  useOrganizer,
  useOrganizerState,
  useOverlaidMachineEntries,
} from "@/features/organize/index.ts";

/** Publish provisional titles even while the Unsent section is outside the virtual window. */
const StartedTitlePublisher = deferredComponent(() =>
  import("./started-rows.tsx").then((module) => module.StartedTitlePublisher),
);

const iconButton =
  "relative grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground focus-ring touch-hit touch-hit-lg hover:bg-sidebar-accent hover:text-foreground";

/** Inside an input, a menu or an editor, Escape is theirs. */
const typing = (target: EventTarget) =>
  target instanceof Element && target.closest("input, textarea, [contenteditable]") !== null;

/**
 * The Threads panel: Inbox + Projects. The title with the filter, Search and New thread, a
 * search over every thread, then the tree: the Inbox with what needs the person, the Running
 * and Recent places, and each project folding open in place with its threads and its own
 * settled ones, quiet projects folded at the foot. A place or a project opens as a focused list
 * with a back arrow (a project with Active and Settled tabs); Back, or Escape outside the
 * search field, returns to the tree where it was. Searching lists the matching threads, then
 * the settled matches, the daemon's included.
 */
export function HomeSidebar() {
  // Other machines' threads join the list, each row marked with its machine.
  const host = useHostIdentity()?.hostId;
  const others = useOverlaidMachineEntries(useMachineEntries(host));
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const list = useHomeList(others, query);
  const { project } = useOrganizerState();
  const device = useSidebarDevice();
  const deviceName = useMachines().find((machine) => machine.id === device)?.name;
  useThreadsWindowSync();
  const organizer = useOrganizer();
  const loaded = useSidebarLoaded();
  // A filter switch usually paints at once (remembered or derived rows): never flash a skeleton.
  const skeleton = useHeld(!loaded);
  const loadedSettled = useSettledEntries(list.settled);
  const search = useSettledSearch(query, list, loadedSettled);
  const [focus, setFocus] = useHomeFocus();
  const panel = usePanelRows({
    list,
    focus,
    search: searching ? search : undefined,
    device,
  });
  // The tree's scroll, kept while a focused list shows, so Back returns where it was.
  const [treeScroll] = useState(scrollMemory);
  const nav = useRef<HTMLElement>(null);
  const { tree } = list;
  const empty =
    !searching &&
    [list.pinned, list.listed, list.snoozed, list.settled].every((ids) => !ids.length) &&
    !tree.quiet.length;
  const directory = useProjectDirectory();
  const keys = useResolvedKeymap();
  const entry = useNewThreadEntry();
  const { only } = entry;
  // One object for the rows' actions, so a row's effects don't re-run on every render.
  const more = useRef(panel.more);
  useLayoutEffect(() => {
    more.current = panel.more;
  });
  const actions = useMemo<SectionActions>(
    () => ({ focus: (next: HomeFocus) => setFocus(next), more: () => more.current() }),
    [setFocus],
  );
  const back = () => setFocus(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || !focus || searching) return;
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    if (typing(event.target)) return;
    event.preventDefault();
    back();
  };
  const focusTitle = !focus
    ? undefined
    : focus.kind === "inbox"
      ? "Inbox"
      : focus.kind === "running"
        ? "Running"
        : focus.kind === "recent"
          ? "Recent"
          : directory.name(focus.id);
  const listKey = searching ? "search" : focus ? JSON.stringify(focus) : "tree";
  const nothing = searching && !panel.rows.length;
  return (
    // Escape bubbles here from the panel's rows and buttons: it leaves a focused list.
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      {focus && focusTitle !== undefined ? (
        <PanelHeader
          title={focusTitle}
          leading={
            <Tip label="Back to Threads">
              <button
                type="button"
                aria-label="Back to Threads"
                onClick={back}
                className={iconButton}
              >
                <Icon icon={ArrowLeftIcon} />
              </button>
            </Tip>
          }
          actions={
            focus.kind === "project" && (
              <Tip label={`New thread in ${focusTitle}`}>
                <Link
                  to="/new"
                  search={{ project: focus.id }}
                  aria-label={`New thread in ${focusTitle}`}
                  className={iconButton}
                >
                  <Icon icon={NotePencilIcon} />
                </Link>
              </Tip>
            )
          }
        />
      ) : (
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
                  className={iconButton}
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
      )}
      <PanelSearch
        value={query}
        onChange={setQuery}
        onEnterList={() => nav.current?.querySelector<HTMLElement>(rowFocusSelector)?.focus()}
      />
      {focus?.kind === "project" && !searching && (
        <FocusTabs tab={focus.tab} onChange={(tab) => setFocus({ ...focus, tab })} />
      )}
      <nav ref={nav} aria-label="Threads" className="flex min-h-0 flex-1 flex-col">
        {loaded && (
          <Suspense fallback={null}>
            <StartedTitlePublisher.Component />
          </Suspense>
        )}
        {!loaded ? (
          skeleton && <ListSkeleton label="threads" shape="thread" />
        ) : empty && !focus ? (
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
            <ThreadList
              rows={unsentOnly}
              needsYou={list.needsYou}
              pinned={list.pinned}
              actions={actions}
            />
          </>
        ) : (
          <>
            {nothing && (
              <p role="status" className="shrink-0 px-4 pt-3 text-ui text-subtle-foreground">
                Nothing matches “{query.trim()}”.
              </p>
            )}
            <ThreadList
              key={listKey}
              rows={panel.rows}
              needsYou={list.needsYou}
              pinned={list.pinned}
              actions={actions}
              hits={search.hits}
              scrollTop={listKey === "tree" ? treeScroll.read() : 0}
              onScroll={listKey === "tree" ? treeScroll.keep : undefined}
            />
          </>
        )}
      </nav>
    </div>
  );
}

const unsentOnly = [{ kind: "unsent" as const }];

/** Where a list was scrolled, kept across its unmounting. */
function scrollMemory() {
  let top = 0;
  return {
    read: () => top,
    keep: (next: number) => {
      top = next;
    },
  };
}
