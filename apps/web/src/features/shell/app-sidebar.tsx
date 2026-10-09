import { Link, useRouterState } from "@tanstack/react-router";
import {
  FolderPlusIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useProjectDirectory } from "@/lib/projects.ts";
import { Icon } from "@/components/icon.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { AccountMenu, WorkspaceMenu } from "./account-menu.tsx";
import { useViewFrame } from "./sidebar-frame.tsx";
import { activeView, navViews } from "./views.ts";

const quick =
  "relative grid size-7 place-items-center rounded-md text-muted-foreground transition-colors duration-(--dur-1) focus-ring touch-hit touch-hit-lg hover:bg-sidebar-accent hover:text-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-foreground";
/**
 * A row of the sidebar's group: New thread and the places under it, as dense as the thread rows.
 * New thread is an action, not a place: it never wears the current page's fill, even on its own
 * page, where it is still `aria-current` for assistive tech (`place` styles the views alone).
 */
const row =
  "flex h-8 items-center gap-2 rounded-md px-2 text-ui text-sidebar-foreground transition-colors duration-(--dur-1) focus-ring hover:bg-sidebar-accent pointer-coarse:h-11 [&_svg]:text-muted-foreground";
const place =
  "aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-foreground aria-[current=page]:[&_svg]:text-foreground";

/** `aria-current` for a link to the place on screen. */
const page = (here: boolean) => (here ? ("page" as const) : undefined);

/**
 * Whether the person has no project yet, once the daemon's list is in: then the way forward
 * is adding one, not a new thread.
 */
export function useNoProjects(): boolean {
  const directory = useProjectDirectory();
  return directory.loaded && directory.projects.length === 0;
}

/**
 * The one sidebar. At the top, "ace ▾" (the daemon) and Search (a dialog over any screen);
 * then New thread (Add project while there is none),
 * Automations and Skills; then the thread list (Settings' pages while in Settings) as its only
 * scrolling part; and at the foot the profile, full width, with the Settings gear beside it.
 */
export function AppSidebar(props: {
  /** Opens Add project; composed in by the app layer, which owns the project dialogs. */
  onAddProject?(): void;
  /** A quiet sign of agents at work (computer use), composed in by the app layer. */
  status?: ReactNode;
  /** The thread list, the body's content unless a view's list takes it (Settings' pages). */
  threads: ReactNode;
}) {
  const { sheet, setBody, bodyClaimed, hideSidebar } = useViewFrame();
  const { openSearch } = useLayout();
  const current = useRouterState({ select: (state) => activeView(state.location.pathname) });
  const noProjects = useNoProjects() && props.onAddProject !== undefined;
  // A dialog opened from the sheet takes its place.
  const leaveSheet = () => {
    if (sheet) hideSidebar();
  };
  return (
    <>
      <nav aria-label="App" className="flex shrink-0 flex-col">
        <div
          data-slot="sidebar-top"
          className={cn(
            "flex h-(--header-h) shrink-0 items-center gap-1 pl-2.5 [-webkit-app-region:drag] [&_a]:[-webkit-app-region:no-drag] [&_button]:[-webkit-app-region:no-drag]",
            // The sheet's own close button sits at the row's end.
            sheet ? "pr-12" : "pr-2.5",
          )}
        >
          <WorkspaceMenu />
          <span className="flex-1" />
          <Tip label="Search" shortcut="search">
            <button
              type="button"
              aria-label="Search"
              aria-haspopup="dialog"
              onClick={() => {
                leaveSheet();
                openSearch();
              }}
              className={quick}
            >
              <Icon icon={MagnifyingGlassIcon} />
            </button>
          </Tip>
        </div>
        <ul className="flex flex-col gap-px px-2 pb-2">
          <li>
            {noProjects ? (
              <button
                type="button"
                className={cn(row, "w-full")}
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
              <Link to="/new" className={row}>
                <Icon icon={NotePencilIcon} />
                New thread
                <Kbd shortcut="newThread" variant="bare" className="ml-auto" />
              </Link>
            )}
          </li>
          {navViews.map((view) => (
            <li key={view.id}>
              <Link
                to={view.to}
                aria-current={page(current === view.id)}
                className={cn(row, place)}
              >
                <Icon icon={view.icon} active={current === view.id} />
                {view.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {/* The thread list, or a view's own (`ViewFrame`): the only part that scrolls. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {!bodyClaimed && props.threads}
        <div ref={setBody} className="contents" />
      </div>
      <div className="flex shrink-0 items-center gap-1 p-2">
        <AccountMenu />
        {props.status}
        <Tip label="Settings" shortcut="settings">
          <Link
            to="/settings"
            aria-label="Settings"
            aria-current={page(current === "settings")}
            className={cn(quick, "size-8")}
          >
            <Icon icon={GearSixIcon} active={current === "settings"} />
          </Link>
        </Tip>
      </div>
    </>
  );
}
