import { Link, useRouterState } from "@tanstack/react-router";
import { ArrowLeftIcon, GearSixIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useProjectDirectory } from "@/lib/projects.ts";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { AccountMenu } from "./account-menu.tsx";
import { useViewFrame } from "./sidebar-frame.tsx";
import { activeView } from "./views.ts";

const quick =
  "relative grid size-7 place-items-center rounded-md text-muted-foreground transition-colors duration-(--dur-1) focus-ring touch-hit touch-hit-lg hover:bg-sidebar-accent hover:text-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-foreground";
/** Back to app uses the thread list's row density. */
const row =
  "flex h-8 items-center gap-2 rounded-md px-2 text-ui text-sidebar-foreground transition-colors duration-(--dur-1) focus-ring hover:bg-sidebar-accent pointer-coarse:h-11 [&_svg]:text-muted-foreground";
/**
 * Whether the person has no project yet, once the daemon's list is in: then the way forward
 * is adding one, not a new thread.
 */
export function useNoProjects(): boolean {
  const directory = useProjectDirectory();
  return directory.loaded && directory.projects.length === 0;
}

/**
 * The one sidebar. At the top, the ace label and Search (a dialog over any screen);
 * then the thread list (or the selected section's list) as its only
 * scrolling part; and at the foot the profile with the Settings gear. Settings, Automations
 * and Skills hide app navigation and the profile, with Back to app above their lists.
 */
export function AppSidebar(props: {
  /** A quiet sign of agents at work (computer use), composed in by the app layer. */
  status?: ReactNode;
  /** The thread list, the body's content unless a view's list takes it (Settings' pages). */
  threads: ReactNode;
}) {
  const { sheet, setBody, bodyClaimed, hideSidebar } = useViewFrame();
  const { openSearch } = useLayout();
  const current = useRouterState({ select: (state) => activeView(state.location.pathname) });
  const section = current === "settings" || current === "automations" || current === "skills";
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
          {section ? (
            <Link to="/new" className={cn(row, "flex-1")} onClick={leaveSheet}>
              <Icon icon={ArrowLeftIcon} />
              Back to app
            </Link>
          ) : (
            <>
              <span className="px-1.5 text-lg font-semibold tracking-[-0.01em] text-foreground">
                ace
              </span>
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
            </>
          )}
        </div>
      </nav>
      {/* The thread list, or a view's own (`ViewFrame`): the only part that scrolls. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {!bodyClaimed && props.threads}
        <div ref={setBody} className="contents" />
      </div>
      <div
        hidden={section}
        inert={section}
        className={cn("shrink-0 items-center gap-1 p-2", section ? "hidden" : "flex")}
      >
        <AccountMenu />
        {props.status}
        <Tip label="Settings" shortcut="settings">
          <Link to="/settings" aria-label="Settings" className={cn(quick, "size-8")}>
            <Icon icon={GearSixIcon} />
          </Link>
        </Tip>
      </div>
    </>
  );
}
