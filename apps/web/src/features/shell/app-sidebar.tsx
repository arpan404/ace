import { Link, useRouterState } from "@tanstack/react-router";
import {
  BellIcon,
  FolderPlusIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
} from "@phosphor-icons/react";
import { needYouPhrase } from "@ace/ui-core/counts";
import { cn } from "@/lib/cn.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useProjectDirectory } from "@/lib/projects.ts";
import { Icon } from "@/components/icon.tsx";
import { CountBadge } from "@/components/ui/dot.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { WorkspaceMenu } from "./account-menu.tsx";
import { useViewFrame } from "./sidebar-frame.tsx";

const quick =
  "relative grid size-7 place-items-center rounded-md text-muted-foreground transition-colors duration-(--dur-1) focus-ring touch-hit touch-hit-lg hover:bg-sidebar-accent hover:text-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-foreground";
const pill =
  "mx-2 mb-2 flex h-8 shrink-0 items-center gap-[9px] rounded-md bg-sidebar-accent px-2.5 text-ui font-medium text-sidebar-foreground transition-colors duration-(--dur-1) focus-ring hover:bg-[color-mix(in_oklab,var(--sidebar-accent),var(--foreground)_4%)] pointer-coarse:h-11 [&_svg]:text-muted-foreground";

/**
 * Whether the person has no project yet, once the daemon's list is in: then the way forward
 * is adding one, not a new thread.
 */
export function useNoProjects(): boolean {
  const directory = useProjectDirectory();
  return directory.loaded && directory.projects.length === 0;
}

/**
 * The sidebar beside the rail: "ace ▾" (the daemon), Activity with what needs you, Search and
 * commands, New thread (Add project while there is none), and the current view's own list as
 * its only scrolling part (the threads on Home).
 */
export function AppSidebar(props: {
  /** What needs the person, counted by Activity; composed in by the app layer. */
  needsYou?: number;
  /** Opens Add project; composed in by the app layer, which owns the project dialogs. */
  onAddProject?(): void;
}) {
  const { sheet, setBody, hideSidebar } = useViewFrame();
  const { setPaletteOpen } = useLayout();
  const onActivity = useRouterState({
    select: (state) => state.location.pathname.startsWith("/activity"),
  });
  const noProjects = useNoProjects() && props.onAddProject !== undefined;
  const needsYou = props.needsYou ?? 0;
  // A dialog or the palette opened from the sheet takes its place.
  const leaveSheet = () => {
    if (sheet) hideSidebar();
  };
  return (
    <>
      <nav aria-label="App" className="flex shrink-0 flex-col">
        <div
          data-slot="sidebar-top"
          className={cn(
            "flex h-(--header-h) shrink-0 items-center gap-1.5 pl-2.5 [-webkit-app-region:drag] [&_a]:[-webkit-app-region:no-drag] [&_button]:[-webkit-app-region:no-drag]",
            // The sheet's own close button sits at the row's end.
            sheet ? "pr-12" : "pr-2.5",
          )}
        >
          <WorkspaceMenu />
          <span className="flex-1" />
          <Tip label="Activity" shortcut="goActivity">
            <Link
              to="/activity"
              aria-label={needsYou > 0 ? `Activity, ${needYouPhrase(needsYou)}` : "Activity"}
              aria-current={onActivity ? "page" : undefined}
              className={quick}
            >
              <Icon icon={BellIcon} active={onActivity} />
              <CountBadge
                count={needsYou}
                label={needYouPhrase(needsYou)}
                className="absolute -top-0.5 -right-1 shadow-[0_0_0_2px_var(--sidebar)]"
              />
            </Link>
          </Tip>
          <Tip label="Search and commands" shortcut="palette">
            <button
              type="button"
              aria-label="Search and commands"
              onClick={() => {
                leaveSheet();
                setPaletteOpen(true);
              }}
              className={quick}
            >
              <Icon icon={MagnifyingGlassIcon} />
            </button>
          </Tip>
        </div>
        {noProjects ? (
          <button
            type="button"
            className={pill}
            onClick={() => {
              leaveSheet();
              props.onAddProject?.();
            }}
          >
            <Icon icon={FolderPlusIcon} />
            Add project
            <Kbd shortcut="addProject" variant="bare" className="ml-auto" />
          </button>
        ) : (
          <Link to="/new" className={pill}>
            <Icon icon={NotePencilIcon} />
            New thread
            <Kbd shortcut="newThread" variant="bare" className="ml-auto" />
          </Link>
        )}
      </nav>
      {/* The current view's list (`ViewFrame`): the only part of the sidebar that scrolls. */}
      <div ref={setBody} className="flex min-h-0 flex-1 flex-col" />
    </>
  );
}
