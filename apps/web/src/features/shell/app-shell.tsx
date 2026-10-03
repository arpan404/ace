import { Outlet, useRouterState } from "@tanstack/react-router";
import { MenuIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet.tsx";
import { CommandPalette } from "@/features/palette/command-palette.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { useLayout } from "@/lib/layout.tsx";
import { ConnectionBadge } from "./connection-badge.tsx";
import { SidebarContent } from "./sidebar.tsx";

/** Sidebar, main view and (per route) a right panel. Navigation collapses to a sheet below md. */
export function AppShell() {
  const layout = useLayout();
  useHotkey("mod+k", () => layout.setPaletteOpen(!layout.paletteOpen));
  const main = useRouteFocus();
  return (
    <div className="flex h-dvh min-h-0">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside
        aria-label="Sidebar"
        className="hidden w-64 shrink-0 border-r bg-sidebar text-sidebar-foreground md:flex md:flex-col"
      >
        <SidebarContent />
      </aside>
      <Sheet open={layout.navOpen} onOpenChange={layout.setNavOpen}>
        <SheetContent side="left" className="w-72 bg-sidebar p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarContent onNavigate={() => layout.setNavOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label="Open navigation"
            onClick={() => layout.setNavOpen(true)}
          >
            <MenuIcon />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-muted-foreground"
            onClick={() => layout.setPaletteOpen(true)}
          >
            <SearchIcon />
            <span className="hidden sm:inline">Search or run a command</span>
            <Kbd className="hidden sm:inline-flex">⌘K</Kbd>
          </Button>
          <div className="ml-auto">
            <ConnectionBadge />
          </div>
        </header>
        <main ref={main} id="main" tabIndex={-1} className="min-h-0 flex-1 outline-none">
          <Outlet />
        </main>
      </div>
      <CommandPalette />
    </div>
  );
}

/** After client-side navigation, move focus to the new view so keyboard and screen-reader
 * users land on its content instead of the link they activated. */
function useRouteFocus() {
  const main = useRef<HTMLElement>(null);
  const path = useRouterState({ select: (state) => state.location.pathname });
  // A ref of the last path (not a first-run flag) so StrictMode's double effect is harmless.
  const shown = useRef(path);
  useEffect(() => {
    if (shown.current === path) return;
    shown.current = path;
    const target = main.current?.querySelector<HTMLElement>("h1") ?? main.current;
    if (target && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target?.focus({ preventScroll: true });
  }, [path]);
  return main;
}
