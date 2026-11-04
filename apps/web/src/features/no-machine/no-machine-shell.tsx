import { Outlet } from "@tanstack/react-router";
import { LocalBoundary } from "@/components/ui/local-boundary.tsx";
import { NoMachineSidebar, SidebarFrame } from "@/features/shell/index.ts";
import { useDismissBootSplash } from "@/lib/boot-splash.ts";

/** The app's frame with no machine: the sidebar beside the current place. */
export function NoMachineShell() {
  // Nothing to load first: the startup screen gives way at once.
  useDismissBootSplash();
  return (
    <div
      data-no-machine=""
      className="relative flex h-[var(--visible-height,100dvh)] min-h-0 overflow-clip bg-sidebar"
    >
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[130] focus:rounded-md focus:bg-popover focus:px-3 focus:py-2 [:root[data-platform=darwin]:not([data-fullscreen])_&]:focus:left-[84px]"
      >
        Skip to content
      </a>
      <SidebarFrame
        sidebar={
          <LocalBoundary label="the sidebar">
            <NoMachineSidebar />
          </LocalBoundary>
        }
      >
        <Outlet />
      </SidebarFrame>
    </div>
  );
}
