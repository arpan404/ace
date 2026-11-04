import { CheckIcon, ClockIcon, NotePencilIcon, TrayIcon } from "@phosphor-icons/react";
import { emptyInboxLine, emptyTabTitle, tabThreads, type ThreadsTab } from "@ace/ui-core";
import { useSidebarLoaded } from "@ace/client-react";
import { Link } from "@tanstack/react-router";
import { Suspense, useMemo, useState, type KeyboardEvent } from "react";
import { Tip } from "@/components/ui/tooltip.tsx";
import { panelIconButton, PanelNoMatch } from "@/components/ui/panel.tsx";
import { Icon } from "@/components/icon.tsx";
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
import { useMachines, usePrimaryMachine } from "@/lib/machines.ts";
import { useThreadsWindowSync } from "./thread-pagination.tsx";
import { useHomeList, useSettledEntries } from "./use-home-threads.ts";
import { useSettledSearch, useThreadHits, type SearchHit } from "./use-panel-search.ts";
import { FoundHits } from "./found-row.tsx";
import { PanelPagingContext, usePanelRows } from "./use-panel-rows.ts";
import { ThreadsTabs } from "./threads-tabs.tsx";
import { PanelTitleSearch } from "@/components/ui/panel-title-search.tsx";
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
 * The Threads panel, under the window's top bar (ADR 0107): its title row ("Threads", Search),
 * the filter row under it (the project and device filter, then New thread), the tabs (Inbox,
 * Snoozed, Settled), then the open tab's list. The Inbox is one flat list across projects and
 * machines in the order the person would act (pinned, needs you, running, unseen, the rest),
 * with no headings; the filter narrows every tab to a project or a device. 1, 2 and 3 switch
 * tabs from anywhere in the panel. The title row's magnifier opens a search in place that narrows
 * every tab to the threads whose title, project, branch or pull request match. Snoozed and Settled show 50 threads at a time, with Show
 * more and Show less at their end. Chats are the Chats panel's. Search (⌘K) opens the palette,
 * which also finds older settled threads.
 */
export function HomeSidebar() {
  // Other machines' threads join the list, each row marked with its machine.
  const host = useHostIdentity()?.hostId;
  const others = useOverlaidMachineEntries(useMachineEntries(host));
  // The title row's search narrows every tab to the threads it matches: by title (forgiving
  // typos) at once, and by their messages through the daemon's search once typing pauses.
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const device = useSidebarDevice();
  const own = usePrimaryMachine().id;
  const asked = useThreadHits(query);
  // Only this machine's daemon searches: another machine's threads match by title alone.
  const found = device && device !== own ? noHits : asked;
  const list = useHomeList(others, query, found);
  // Settled also lists older settled threads the search found that the list hasn't paged in.
  const settledShown = useSettledEntries(list.settled);
  const older = useSettledSearch(query, list, settledShown);
  const settledMatches = useMemo(
    () => (searching ? older.matches.map((match) => match.id) : undefined),
    [searching, older.matches],
  );
  const { project, tab } = useOrganizerState();
  const deviceName = useMachines().find((machine) => machine.id === device)?.name;
  useThreadsWindowSync();
  const organizer = useOrganizer();
  const loaded = useSidebarLoaded();
  // A filter switch usually paints at once (remembered or derived rows): never flash a skeleton.
  const skeleton = useHeld(!loaded);
  const { rows, paging } = usePanelRows({
    list,
    tab,
    project,
    device,
    settled: settledMatches,
  });
  const empty =
    !tabThreads(list.panel, tab).length && !(tab === "settled" && searching && older.hits.size);
  // No thread anywhere (not even snoozed or settled): the first-run words, not Inbox zero.
  const none = [list.panel.inbox, list.panel.snoozed, list.panel.settled].every(
    (ids) => !ids.length,
  );
  const directory = useProjectDirectory();
  const keys = useResolvedKeymap();
  const narrowed = project
    ? `in ${directory.name(project)}`
    : deviceName
      ? `on ${deviceName}`
      : undefined;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <PanelTitleSearch title="Threads" label="Search threads" query={query} onQuery={setQuery} />
      <div className="flex h-8 shrink-0 items-center gap-1 pr-2.5 pl-2">
        <ProjectFilter />
        <NewThreadButton />
      </div>
      <nav
        aria-label="Threads"
        className="relative flex min-h-0 flex-1 flex-col [&_[data-virtual-viewport]]:pb-[52px]"
        onKeyDown={(event) => {
          const next = tabKey(event);
          if (!next) return;
          event.preventDefault();
          organizer.setTab(next);
        }}
      >
        <ThreadsTabs
          tab={tab}
          panel={list.panel}
          needsYou={list.needsYou}
          onTab={(next) => organizer.setTab(next)}
        />
        {loaded && (
          <Suspense fallback={null}>
            <StartedTitlePublisher.Component />
          </Suspense>
        )}
        {!loaded ? (
          skeleton && <ListSkeleton label="threads" shape="thread" />
        ) : empty && searching ? (
          <div className="px-2">
            <PanelNoMatch>No threads match.</PanelNoMatch>
          </div>
        ) : empty ? (
          <>
            <EmptyState
              className="shrink-0 justify-start pt-6"
              icon={tab === "inbox" ? TrayIcon : tab === "snoozed" ? ClockIcon : CheckIcon}
              title={emptyTabTitle(tab, narrowed, none)}
              description={
                tab !== "inbox"
                  ? undefined
                  : none && !narrowed
                    ? `Start one${keys.newThread ? ` with ${formatKeys(keys.newThread)}` : ""}. Threads from every project and computer land here.`
                    : emptyInboxLine
              }
              action={
                project ? (
                  <button
                    type="button"
                    className="text-ui font-medium text-foreground underline-offset-4 hover:underline"
                    onClick={() => organizer.setProject(null)}
                  >
                    Show everywhere
                  </button>
                ) : device ? (
                  <button
                    type="button"
                    className="text-ui font-medium text-foreground underline-offset-4 hover:underline"
                    onClick={() => organizer.setDevice(undefined)}
                  >
                    Show all devices
                  </button>
                ) : tab === "inbox" && directory.loaded && !directory.projects.length ? (
                  <AddProjectAction />
                ) : undefined
              }
            />
            {tab === "inbox" && (
              <ThreadList rows={unsentOnly} needsYou={list.needsYou} pinned={list.pinned} triage />
            )}
          </>
        ) : (
          <PanelPagingContext value={paging}>
            <FoundHits value={older.hits}>
              <ThreadList rows={rows} needsYou={list.needsYou} pinned={list.pinned} triage />
            </FoundHits>
          </PanelPagingContext>
        )}
      </nav>
    </div>
  );
}

const tabKeys: Record<string, ThreadsTab> = { "1": "inbox", "2": "snoozed", "3": "settled" };

/** 1, 2 or 3 pressed in the panel, outside a field and with no modifier: the tab it opens. */
function tabKey(event: KeyboardEvent): ThreadsTab | undefined {
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return undefined;
  if (
    event.target instanceof HTMLElement &&
    event.target.closest("input, textarea, [contenteditable], [role=menu]")
  )
    return undefined;
  return tabKeys[event.key];
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
 * New thread, the pencil at the filter row's end. With one project it opens New
 * thread there; with several it asks which (Shift skips the question: the current project).
 */
function NewThreadButton() {
  const entry = useNewThreadEntry();
  const { only } = entry;
  return (
    <Tip label="New thread" shortcut="newThread">
      <Link
        to="/new"
        {...(only ? { search: { project: only } } : {})}
        aria-label="New thread"
        className={panelIconButton}
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
const noHits: ReadonlyMap<string, SearchHit> = new Map();
