import { Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { ActivityNotifier, useNeedsYouCount } from "@/features/activity/index.ts";
import { MoreMenuItems } from "@/features/more/index.ts";
import { CommandPalette } from "@/features/palette/index.ts";
import { ProjectsHost, useProjectDialogs } from "@/features/projects/index.ts";
import { AppSidebar, GlobalHotkeys, Rail, SidebarFrame } from "@/features/shell/index.ts";
import { useDismissBootSplash } from "@/lib/boot-splash.ts";

/** Wallpaper, the rail of views, the sidebar and the selected view (its list there, its column). */
export function AppShell() {
  const shell = useRouteFocus();
  // The static boot shell from index.html fades into this one.
  useDismissBootSplash();
  return (
    <ProjectsHost>
      <div ref={shell} className="relative flex h-dvh min-h-0 overflow-hidden">
        <div className="wallpaper" />
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[130] focus:rounded-md focus:bg-popover focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <SidebarFrame rail={<ViewRail />} sidebar={<ShellSidebar />}>
          <Outlet />
        </SidebarFrame>
        <CommandPalette />
        <ShellHotkeys />
        <ActivityNotifier />
      </div>
    </ProjectsHost>
  );
}

/** The rail with what other slices own: More's menu. */
function ViewRail() {
  return <Rail moreMenu={<MoreMenuItems />} />;
}

/**
 * The sidebar with what other slices own: Activity's count on its bell (the number Activity's
 * header shows; a change re-renders only the sidebar) and Add project for an empty world.
 */
function ShellSidebar() {
  const projects = useProjectDialogs();
  return (
    <AppSidebar
      needsYou={useNeedsYouCount()}
      onAddProject={() => projects.open({ kind: "add", tab: "open" })}
    />
  );
}

function ShellHotkeys() {
  const projects = useProjectDialogs();
  return <GlobalHotkeys onAddProject={() => projects.open({ kind: "add", tab: "open" })} />;
}

/** After client-side navigation, move focus to the new view's title so keyboard and
 * screen-reader users land on it instead of the link they activated. */
function useRouteFocus() {
  const shell = useRef<HTMLDivElement>(null);
  const path = useRouterState({ select: (state) => state.location.pathname });
  // A ref of the last path (not a first-run flag) so StrictMode's double effect is harmless.
  const shown = useRef(path);
  useEffect(() => {
    if (shown.current === path) return;
    shown.current = path;
    const target = shell.current?.querySelector<HTMLElement>("header h1");
    if (!target) return;
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }, [path]);
  return shell;
}
