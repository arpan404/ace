import { ChatsIcon, NotePencilIcon } from "@phosphor-icons/react";
import { useSidebarLoaded } from "@ace/client-react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Suspense } from "react";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { panelIconButton, PanelTitleRow } from "@/components/ui/panel.tsx";
import { Icon } from "@/components/icon.tsx";
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
 * The Threads panel, under the window's top bar (ADR 0107): its title row ("ace" and its filter
 * caret, Search, New thread), then the list: Active, every unsettled thread across
 * projects (pinned ones first, then what needs the person, then what is at work, then the rest),
 * then Projects, each folding open in place with only its settled threads, quiet projects folded
 * at the foot. History opens from each project's row and from the palette. Chats are the Chats
 * panel's. Search (⌘K) opens the palette.
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
  const rows = usePanelRows({ list });
  const { tree } = list;
  // No thread at all: projects that hold none (Quiet projects) don't count.
  const empty =
    [list.pinned, list.listed, list.snoozed, list.settled].every((ids) => !ids.length) &&
    !tree.projects.length;
  const directory = useProjectDirectory();
  const keys = useResolvedKeymap();
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <PanelTitleRow className="@container/thread-filters">
        <span className="flex min-w-0 flex-1">
          <ProjectFilter />
        </span>
        <PaletteButton />
        <NewThreadButton />
      </PanelTitleRow>
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
                  <AddProjectAction />
                ) : undefined
              }
            />
            <ThreadList rows={unsentOnly} needsYou={list.needsYou} pinned={list.pinned} />
          </>
        ) : (
          <ThreadList rows={rows} needsYou={list.needsYou} pinned={list.pinned} />
        )}
      </nav>
    </div>
  );
}

/** With no project yet, the empty panel's way to add one. */
function AddProjectAction() {
  const projects = useProjectDialogs();
  return (
    <button
      type="button"
      className="text-ui font-medium text-foreground underline-offset-4 hover:underline"
      onClick={() => projects.open({ kind: "add", tab: "sources" })}
      onPointerEnter={projects.preload}
    >
      Add project
    </button>
  );
}

/**
 * New thread, the pencil at the title row's end after Search. With one project it opens New
 * thread there; with several it asks which (Shift skips the question: the current project).
 */
function NewThreadButton() {
  const entry = useNewThreadEntry();
  const { only } = entry;
  const here = useRouterState({ select: (state) => state.location.pathname === "/new" });
  return (
    <Tip label="New thread" shortcut="newThread">
      <Link
        to="/new"
        {...(only ? { search: { project: only } } : {})}
        aria-label="New thread"
        aria-current={here ? "page" : undefined}
        className={cn(
          panelIconButton,
          "aria-[current=page]:bg-active aria-[current=page]:text-foreground",
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
        <Icon icon={NotePencilIcon} size={18} />
      </Link>
    </Tip>
  );
}

const unsentOnly = [{ kind: "unsent" as const }];
