import { Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { ActivityNotifier, useNeedsYouCount } from "@/features/activity/index.ts";
import { CommandPalette } from "@/features/palette/index.ts";
import { GlobalHotkeys, Rail } from "@/features/shell/index.ts";

/** Wallpaper, the rail of views, and the selected view (its sidebar and main column). */
export function AppShell() {
  const shell = useRouteFocus();
  return (
    <div ref={shell} className="relative flex h-dvh min-h-0 overflow-hidden">
      <div className="wallpaper" />
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[130] focus:rounded-md focus:bg-popover focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <ViewRail />
      <div className="relative z-[1] flex min-h-0 min-w-0 flex-1">
        <Outlet />
      </div>
      <CommandPalette />
      <GlobalHotkeys />
      <ActivityNotifier />
    </div>
  );
}

/** The rail with Activity's count: the same number its header shows. */
function ViewRail() {
  const needsYou = useNeedsYouCount();
  return <Rail badges={{ activity: needsYou }} />;
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
