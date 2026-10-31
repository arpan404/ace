import {
  BellIcon,
  ChatsIcon,
  ClockCounterClockwiseIcon,
  NotePencilIcon,
} from "@phosphor-icons/react";
import { useSidebarLoaded } from "@ace/client-react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Suspense, useRef, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
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
import { PanelSearch } from "./panel-header.tsx";
import { useSettledSearch } from "./use-panel-search.ts";
import { rowFocusSelector } from "./list-focus.ts";
import { usePanelRows } from "./use-panel-rows.ts";
import { InboxOverlay } from "./inbox-overlay.tsx";
import { useInboxOpen, useInboxStore } from "./use-inbox-open.ts";
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

/**
 * The Threads panel: projects, with the Inbox one press away. The title with the Inbox bell,
 * Search, the filter and New thread, a search over every thread, then the tree: each project
 * folding open in place with its open threads and its recently settled ones, quiet projects
 * folded at the foot, and History below the list. The bell (or ⌘I) opens the Inbox over the
 * list. Searching lists the matching threads, then the settled matches, the daemon's included.
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
  const rows = usePanelRows({ list, search: searching ? search : undefined, device });
  const nav = useRef<HTMLElement>(null);
  const bell = useRef<HTMLButtonElement>(null);
  const inbox = useInboxStore();
  const inboxOpen = useInboxOpen();
  const { tree } = list;
  const empty =
    !searching &&
    [list.pinned, list.listed, list.snoozed, list.settled].every((ids) => !ids.length) &&
    !tree.quiet.length;
  const directory = useProjectDirectory();
  const keys = useResolvedKeymap();
  const entry = useNewThreadEntry();
  const { only } = entry;
  const listKey = searching ? "search" : "tree";
  const nothing = searching && !rows.length;
  const waiting = list.inbox.length;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title="Threads"
        className="@container/thread-filters"
        actions={
          <>
            <Tip label="Inbox" shortcut="inbox">
              <button
                ref={bell}
                type="button"
                aria-label={waiting ? `Inbox, ${waiting} waiting` : "Inbox"}
                aria-expanded={inboxOpen}
                aria-haspopup="dialog"
                onClick={inbox.toggle}
                className={cn(iconButton, inboxOpen && "bg-active text-foreground")}
              >
                <Icon icon={BellIcon} />
                {waiting > 0 && (
                  <span
                    aria-hidden
                    data-inbox-badge=""
                    className="absolute -top-0.5 -right-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-status-needs-you px-1 text-[10px] leading-none font-semibold text-background tabular-nums shadow-[0_0_0_2px_var(--sidebar)]"
                  >
                    {waiting}
                  </span>
                )}
              </button>
            </Tip>
            <PaletteButton />
            <ThreadsActions />
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
      <PanelSearch
        value={query}
        onChange={setQuery}
        onEnterList={() => nav.current?.querySelector<HTMLElement>(rowFocusSelector)?.focus()}
      />
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
            <ThreadList rows={unsentOnly} needsYou={list.needsYou} pinned={list.pinned} />
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
              rows={rows}
              needsYou={list.needsYou}
              pinned={list.pinned}
              hits={search.hits}
            />
          </>
        )}
      </nav>
      {loaded && <HistoryFoot count={list.settledTotal} />}
      {inboxOpen && <InboxOverlay ids={list.inbox} bell={bell} onClose={() => inbox.set(false)} />}
    </div>
  );
}

/** The quiet way to History at the panel's foot, with how many threads it holds. */
function HistoryFoot(props: { count: number }) {
  const here = useRouterState({ select: (state) => state.location.pathname === "/history" });
  return (
    <div className="shrink-0 border-t border-border px-2 pt-1 pb-2">
      <Link
        to="/history"
        aria-current={here ? "page" : undefined}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-ui text-muted-foreground transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover hover:text-foreground",
          here && "bg-active text-foreground",
        )}
      >
        <Icon icon={ClockCounterClockwiseIcon} size={14} />
        <span className="min-w-0 flex-1 truncate">History</span>
        {props.count > 0 && (
          <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">
            {props.count}
          </span>
        )}
      </Link>
    </div>
  );
}

const unsentOnly = [{ kind: "unsent" as const }];
