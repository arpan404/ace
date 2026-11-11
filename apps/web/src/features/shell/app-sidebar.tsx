import { useRouterState } from "@tanstack/react-router";
import { useRef, type ReactNode } from "react";
import { NavButtons } from "./app-header.tsx";
import { AppRail } from "./app-rail.tsx";
import { panelCanvasClass } from "./canvas.ts";
import { ForgePanel } from "./forge-panel.tsx";
import { useViewFrame } from "./sidebar-frame.tsx";
import { useSpadeFollow } from "./use-spade-follow.ts";
import { activeView } from "./views.ts";

/**
 * The one sidebar: its top row is the left of the window's top bar (the
 * macOS traffic lights, then back, forward and the sidebar's toggle), and under it the rail of
 * places (on the frame colour) beside the current place's panel, where the canvas begins: the
 * page surface with its rounded corner (`panelCanvasClass`), the only part that scrolls. Threads' panel is the
 * thread list, which draws its own title row with the filter and Search;
 * Code review's lists its three pages; Settings, Automations and Skills draw their own lists into it
 * (`ViewFrame`). ⌘K opens the palette anywhere.
 */
export function AppSidebar(props: {
  /** The thread list, the panel's content unless a view's list takes it (Settings' pages). */
  threads: ReactNode;
  /** Code review's place in the rail (Inbox, Pull requests and Issues), current while one is open. */
  forge?: ((current: boolean) => ReactNode) | undefined;
  /** Usage's place in the rail's foot. */
  usage?: ((current: boolean) => ReactNode) | undefined;
  /** Spade's place in the rail. */
  spade?: ((current: boolean, to: string, search: object) => ReactNode) | undefined;
}) {
  const { setBody, bodyClaimed, sheet } = useViewFrame();
  // Spade's eyes follow the pointer while it is over the rail or the panel beside it.
  const followRef = useRef<HTMLDivElement>(null);
  useSpadeFollow(followRef);
  const onForge = useRouterState({
    select: (state) => activeView(state.location.pathname) === "forge",
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        data-slot="sidebar-top"
        className="flex h-(--header-h) shrink-0 items-center gap-0.5 pl-3 [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]"
      >
        {/* The sheet has its own way to close at this row's end; the header keeps navigation. */}
        {!sheet && <NavButtons />}
      </div>
      <div ref={followRef} data-slot="sidebar-body" className="flex min-h-0 flex-1">
        <AppRail forge={props.forge} usage={props.usage} spade={props.spade} />
        <div
          data-slot="sidebar-panel"
          className={`flex min-h-0 min-w-0 flex-1 flex-col ${sheet ? "" : panelCanvasClass}`}
        >
          {!bodyClaimed && (onForge ? <ForgePanel /> : props.threads)}
          <div ref={setBody} className="contents" />
        </div>
      </div>
    </div>
  );
}
