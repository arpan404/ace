import { useRouterState } from "@tanstack/react-router";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useLayout } from "@/lib/layout.tsx";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { AppRail } from "./app-rail.tsx";
import { ForgePanel } from "./forge-panel.tsx";
import { useViewFrame } from "./sidebar-frame.tsx";
import { PanelHeader } from "./view-frame.tsx";
import { activeView } from "./views.ts";

const quick =
  "relative grid size-7 place-items-center rounded-md text-muted-foreground transition-colors duration-(--motion-fast) focus-ring touch-hit touch-hit-lg hover:bg-hover hover:text-foreground";

/**
 * The one sidebar: the rail of places on the left, always there, and beside it the current
 * place's panel, the only part that scrolls. Threads' panel is the thread list under its title
 * with Search (a dialog over any screen); GitHub's lists its three pages; Settings, Automations
 * and Skills draw their own lists into it (`ViewFrame`). Back, forward and the sidebar's toggle
 * sit in the main column's header.
 */
export function AppSidebar(props: {
  /** The thread list, the panel's content unless a view's list takes it (Settings' pages). */
  threads: ReactNode;
  /** GitHub's place in the rail (Inbox, Pull requests and Issues), current while one is open. */
  forge?: ((current: boolean) => ReactNode) | undefined;
}) {
  const { sheet, setBody, bodyClaimed, hideSidebar } = useViewFrame();
  const { setPaletteOpen } = useLayout();
  const onForge = useRouterState({
    select: (state) => activeView(state.location.pathname) === "forge",
  });
  const search = (
    <Tip label="Search" shortcut="palette">
      <button
        type="button"
        aria-label="Search"
        aria-haspopup="dialog"
        onClick={() => {
          // A dialog opened from the sheet takes its place.
          if (sheet) hideSidebar();
          setPaletteOpen(true);
        }}
        className={quick}
      >
        <Icon icon={MagnifyingGlassIcon} />
      </button>
    </Tip>
  );
  return (
    <div className="flex min-h-0 flex-1">
      <AppRail forge={props.forge} />
      <div
        data-slot="sidebar-panel"
        className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-sidebar-border"
      >
        {!bodyClaimed &&
          (onForge ? (
            <ForgePanel />
          ) : (
            <>
              <PanelHeader title="Threads" actions={search} />
              {props.threads}
            </>
          ))}
        <div ref={setBody} className="contents" />
      </div>
    </div>
  );
}
