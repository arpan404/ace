import { useConnectionState } from "@ace/client-react";
import { Outlet, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { ActivityNotifier, useNeedsYouCount } from "@/features/activity/index.ts";
import { MoreMenuItems } from "@/features/more/index.ts";
import { CommandPalette } from "@/features/palette/index.ts";
import { ProjectsHost } from "@/features/projects/index.ts";
import { AppSidebar, GlobalHotkeys, Rail, SidebarFrame } from "@/features/shell/index.ts";
import { useDesktopUpdates } from "@/boot/desktop-updates.ts";
import { useDismissBootSplash } from "@/lib/boot-splash.ts";
import { cn } from "@/lib/cn.ts";

/**
 * Wallpaper, the rail of views, the sidebar and the selected view (its list there, its column).
 * `data-connection` carries the daemon connection's state: while it isn't ready, live spinners
 * pause and dim, since nothing they stand for can arrive (no layout changes).
 */
export function AppShell() {
  const shell = useRouteFocus();
  const connection = useConnectionState();
  // The static boot shell from index.html fades into this one.
  useDismissBootSplash();
  useDesktopUpdates();
  return (
    <ProjectsHost>
      <div
        ref={shell}
        data-connection={connection}
        className={cn(
          "relative flex h-dvh min-h-0 overflow-hidden",
          "[&:not([data-connection=ready])_:is([data-slot=spinner],[data-live])]:[animation-play-state:paused]",
          "[&:not([data-connection=ready])_:is([data-slot=spinner],[data-live])]:opacity-60",
        )}
      >
        <div className="wallpaper" />
        <a
          href="#main"
          // The desktop's macOS traffic lights cover the window's top-left corner.
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[130] focus:rounded-md focus:bg-popover focus:px-3 focus:py-2 [:root[data-platform=darwin]:not([data-fullscreen])_&]:focus:left-[84px]"
        >
          Skip to content
        </a>
        <SidebarFrame rail={<ViewRail />} sidebar={<AppSidebar />}>
          <Outlet />
        </SidebarFrame>
        <CommandPalette />
        <GlobalHotkeys />
        <ActivityNotifier />
      </div>
    </ProjectsHost>
  );
}

/**
 * The rail with what other slices own: Activity's count (the number its header shows; a change
 * re-renders only the rail) and More's menu.
 */
function ViewRail() {
  return <Rail badges={{ activity: useNeedsYouCount() }} moreMenu={<MoreMenuItems />} />;
}

/** Where focus already is on purpose; a navigation must not pull it out of these. */
const keepFocusIn =
  '[role="dialog"], [role="alertdialog"], [data-slot="composer"], textarea, input, [contenteditable="true"]';
const settleFrames = 30;

/**
 * After client-side navigation, move focus to the new view's title so keyboard and
 * screen-reader users land on it instead of the link they activated (which may be gone).
 * It waits for the router to say the new screen rendered (routes load lazily and some
 * redirect), then a frame, so it never focuses the outgoing screen's title.
 */
function useRouteFocus() {
  const router = useRouter();
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0;
    // The title on screen when a navigation starts: never the one to focus after it.
    let outgoing: HTMLElement | null = null;
    const title = () => shell.current?.querySelector<HTMLElement>("header h1") ?? null;
    const stops = [
      router.subscribe("onBeforeNavigate", (event) => {
        if (event.pathChanged) outgoing = title();
      }),
      router.subscribe("onRendered", (event) => {
        if (!event.pathChanged) return;
        cancelAnimationFrame(frame);
        let left = settleFrames;
        const focusTitle = () => {
          const active = document.activeElement;
          if (active instanceof HTMLElement && active.closest(keepFocusIn)) return;
          const target = title();
          // A lazy screen (or a redirect) can paint its header a few frames after the route
          // renders; until then the outgoing title may still be there. A screen that keeps
          // its header across paths gets it once the wait is over.
          if ((!target || (target === outgoing && target.isConnected)) && --left > 0) {
            frame = requestAnimationFrame(focusTitle);
            return;
          }
          if (!target) return;
          outgoing = null;
          if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
          target.focus({ preventScroll: true });
        };
        frame = requestAnimationFrame(focusTitle);
      }),
    ];
    return () => {
      for (const stop of stops) stop();
      cancelAnimationFrame(frame);
    };
  }, [router]);
  return shell;
}
