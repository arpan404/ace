import { useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppRail } from "./app-rail.tsx";
import { ForgePanel } from "./forge-panel.tsx";
import { useViewFrame } from "./sidebar-frame.tsx";
import { activeView } from "./views.ts";

/**
 * The one sidebar: the rail of places on the left, always there, and beside it the current
 * place's panel, the only part that scrolls. Threads' panel is the thread list, which draws its
 * own title row (`PanelHeader`) with its filter, New thread and search; GitHub's lists its three
 * pages; Settings, Automations and Skills draw their own lists into it (`ViewFrame`). Back,
 * forward and the sidebar's toggle sit in the main column's header; ⌘K opens the palette anywhere.
 */
export function AppSidebar(props: {
  /** The thread list, the panel's content unless a view's list takes it (Settings' pages). */
  threads: ReactNode;
  /** GitHub's place in the rail (Inbox, Pull requests and Issues), current while one is open. */
  forge?: ((current: boolean) => ReactNode) | undefined;
}) {
  const { setBody, bodyClaimed } = useViewFrame();
  const onForge = useRouterState({
    select: (state) => activeView(state.location.pathname) === "forge",
  });
  return (
    <div className="flex min-h-0 flex-1">
      <AppRail forge={props.forge} />
      <div
        data-slot="sidebar-panel"
        className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-sidebar-border"
      >
        {!bodyClaimed && (onForge ? <ForgePanel /> : props.threads)}
        <div ref={setBody} className="contents" />
      </div>
    </div>
  );
}
