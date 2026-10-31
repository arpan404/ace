import {
  BellIcon,
  ChatsIcon,
  ClockCounterClockwiseIcon,
  NotePencilIcon,
} from "@phosphor-icons/react";
import { useSidebarLoaded } from "@ace/client-react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Suspense, useRef } from "react";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { PaletteButton } from "@/features/shell/index.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { useNewThreadEntry, useProjectDialogs } from "@/features/projects/index.ts";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useHeld } from "@/lib/held.ts";
import { useHostIdentity } from "@/lib/host-name.ts";
import { useMachineEntries } from "@/lib/machine-threads.ts";
import { useProjectDirectory } from "@/lib/projects.ts";
import { useResolvedKeymap } from "@/lib/keybindings.ts";
import { formatKeys } from "@/lib/keymap.ts";
import { ProjectFilter } from "./project-filter.tsx";
import { ThreadList } from "./thread-list.tsx";
import { useSidebarDevice } from "./device-filter-state.ts";
import { useMachines } from "@/lib/machines.ts";
import { useThreadsWindowSync } from "./thread-pagination.tsx";
import { useHomeList } from "./use-home-threads.ts";
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
  "relative grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-(--motion-fast) focus-ring touch-hit touch-hit-lg hover:bg-hover hover:text-foreground";

/**
 * The Threads panel, under the window's top bar: its title row ("ace" and its filter caret, the
 * Inbox bell, Search), a New thread row, then the list: Pinned threads, and Projects, each
 * folding open in place with its open threads and its recently settled ones, quiet projects
 * folded at the foot, and History below the list. The bell (or ⌘I) opens the Inbox over the
 * list; Search (⌘K) opens the palette.
 */
export function HomeSidebar() {
  // Other machines' threads join the list, each row marked with its machine.
  const host = useHostIdentity()?.hostId;
  const others = useOverlaidMachineEntries(useMachineEntries(host));
  const list = useHomeList(others);
  const { project } = useOrganizerState();
  const device = useSidebarDevice();
  const deviceName = useMachines().find((machine) => machine.id === device)?.name;
  useThreadsWindowSync();
  const organizer = useOrganizer();
  const loaded = useSidebarLoaded();
  // A filter switch usually paints at once (remembered or derived rows): never flash a skeleton.
  const skeleton = useHeld(!loaded);
  const rows = usePanelRows({ list, device });
  const bell = useRef<HTMLButtonElement>(null);
  const inbox = useInboxStore();
  const inboxOpen = useInboxOpen();
  const { tree } = list;
  const empty =
    [list.pinned, list.listed, list.snoozed, list.settled].every((ids) => !ids.length) &&
    !tree.quiet.length;
  const directory = useProjectDirectory();
  const projects = useProjectDialogs();
  const keys = useResolvedKeymap();
  const waiting = list.inbox.length;
  // The bell's dot asks loudest for what it holds: the warning colour while anything needs the
  // person, the blue while it holds only results not yet seen.
  const needsYou = list.inbox.some((id) => list.needsYou.includes(id));
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        data-slot="panel-top"
        className="@container/thread-filters flex h-(--header-h) shrink-0 items-center gap-1 pr-2.5 pl-2"
      >
        <span className="flex min-w-0 flex-1">
          <ProjectFilter />
        </span>
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
            <Icon icon={BellIcon} size={18} />
            {waiting > 0 && (
              <span
                aria-hidden
                data-inbox-dot=""
                data-tone={needsYou ? "needs-you" : "unread"}
                className="absolute top-1.5 right-1.5 size-2 rounded-full bg-(--tone) ring-2 ring-sidebar"
              />
            )}
          </button>
        </Tip>
        <PaletteButton />
      </div>
      <NewThreadRow />
      <nav aria-label="Threads" className="flex min-h-0 flex-1 flex-col">
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
                ) : directory.loaded && !directory.projects.length ? (
                  <button
                    type="button"
                    className="text-ui font-medium text-foreground underline-offset-4 hover:underline"
                    onClick={() => projects.open({ kind: "add", tab: "sources" })}
                    onPointerEnter={projects.preload}
                  >
                    Add project
                  </button>
                ) : undefined
              }
            />
            <ThreadList rows={unsentOnly} needsYou={list.needsYou} pinned={list.pinned} />
          </>
        ) : (
          <ThreadList rows={rows} needsYou={list.needsYou} pinned={list.pinned} />
        )}
      </nav>
      {loaded && <HistoryFoot count={list.settledTotal} />}
      {inboxOpen && <InboxOverlay ids={list.inbox} bell={bell} onClose={() => inbox.set(false)} />}
    </div>
  );
}

/**
 * The panel's first row: New thread, as a pencil and the words. With one project it opens New
 * thread there; with several it asks which (Shift skips the question: the current project).
 */
function NewThreadRow() {
  const entry = useNewThreadEntry();
  const { only } = entry;
  const here = useRouterState({ select: (state) => state.location.pathname === "/new" });
  return (
    <div className="shrink-0 px-2 pb-1">
      <Tip label="New thread" shortcut="newThread">
        <Link
          to="/new"
          {...(only ? { search: { project: only } } : {})}
          aria-label="New thread"
          aria-current={here ? "page" : undefined}
          className={cn(
            "flex h-(--row-height) w-full items-center gap-2.5 rounded-md px-2.5 text-md text-foreground transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover",
            here && "bg-active",
          )}
          onClick={(event) => {
            if (event.shiftKey) {
              event.preventDefault();
              entry.here();
            } else if (!only) {
              event.preventDefault();
              entry.start();
            }
          }}
        >
          <Icon icon={NotePencilIcon} className="text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">New thread</span>
        </Link>
      </Tip>
    </div>
  );
}

/** The quiet way to History at the panel's foot, with how many threads it holds. */
function HistoryFoot(props: { count: number }) {
  const here = useRouterState({ select: (state) => state.location.pathname === "/history" });
  return (
    <div className="shrink-0 px-2 pt-1 pb-2">
      <Link
        to="/history"
        aria-current={here ? "page" : undefined}
        className={cn(
          "flex h-(--row-height) w-full items-center gap-2.5 rounded-md px-2.5 text-md text-muted-foreground transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover hover:text-foreground",
          here && "bg-active text-foreground",
        )}
      >
        <Icon icon={ClockCounterClockwiseIcon} />
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
