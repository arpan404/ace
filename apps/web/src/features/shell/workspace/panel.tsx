import { Activity, createElement, Suspense, useEffect, useRef, type ReactNode } from "react";
import { ResizeHandle } from "@/components/ui/resize-handle.tsx";
import { cn } from "@/lib/cn.ts";
import { boundaryMarker, controlDivider, toolbarEdge } from "@/components/ui/rules.ts";
import { useLayout } from "@/lib/layout.tsx";
import {
  PanelPlaceContext,
  shownTab,
  type ScopeWorkspace,
  type WorkspaceActions,
  type WorkspaceDefinition,
} from "@/lib/workspace/index.ts";
import { findComposerInput } from "@/lib/focus-composer.ts";
import { roomLimits, type PanelMode } from "@/lib/shell-room.ts";
import { clampToBounds, type Bounds } from "./bounds.ts";
import { useFocusBackOnHide } from "./panel-focus.ts";
import { TabContent } from "./tab-content.tsx";

// The close question ships with the panel: a tab can only be closed once the panel has loaded.
export { CloseConfirm } from "./close-confirm.tsx";
import { TabStrip } from "./tab-strip.tsx";

export interface PanelLayout {
  /**
   * Where it docks (`allocateRoom`): beside the column, under it, or taking the canvas in full
   * view (`full`) or in the column's place on a phone (`replace`). Never over the chat.
   */
  mode: Exclude<PanelMode, "closed">;
  /**
   * Docked beside the column, or in full view: the panel runs the window's full height and its
   * strip is the top bar's part above it, on the frame colour; its body starts the canvas.
   */
  topBar?: boolean;
  bounds: Bounds;
  /** Its width beside the column (or height under it), already fitted to the room. */
  size: number;
}

/**
 * The side panel: its strip (tabs, +, the showing tab's actions, the panel's controls), its tab
 * views and its resize edge. Docked beside the column or taking the canvas, the strip is the
 * window's top bar above the panel; docked under the column it heads the panel. It always docks,
 * never a modal or sheet; hidden Activity preserves tab state.
 */
export function WorkspacePanel(props: {
  scope: string;
  definition: WorkspaceDefinition;
  workspace: ScopeWorkspace;
  actions: WorkspaceActions;
  layout: PanelLayout;
  /** Before the tabs: the header's navigation in full view. */
  leading?: ReactNode;
  /** After the tabs: full view and the panel's toggle. */
  controls?: ReactNode;
  /** Under the strip: the connection notice in full view. */
  notice?: ReactNode;
  restoreFocus?(): HTMLElement | null;
}) {
  const { workspace, actions, definition, layout } = props;
  const bottom = layout.mode === "bottom";
  // Taking the canvas: full view, or a phone's whole canvas in the column's place.
  const expanded = layout.mode === "full" || layout.mode === "replace";
  const replace = layout.mode === "replace";
  const { setRightPanel } = useLayout();
  // Beside the column or in the canvas it takes the sidebar's room on a crowded window; under
  // the column it needs none.
  const takesRoom = workspace.open && !bottom;
  useEffect(() => {
    if (!takesRoom) return;
    setRightPanel(() => actions.setOpen(false));
    return () => setRightPanel(undefined);
  }, [takesRoom, setRightPanel, actions]);
  const section = useRef<HTMLElement>(null);
  const restoreFocus = () => toggleOutside(section.current) ?? props.restoreFocus?.() ?? false;
  // Hiding the panel with focus in it hands focus to the composer; on a phone to the header's
  // toggle instead, so going back to the chat never raises the keyboard.
  const focusBack = useFocusBackOnHide(section, workspace.open, () =>
    replace ? restoreFocus() : (findComposerInput() ?? restoreFocus()),
  );
  const size = clampToBounds(layout.size, layout.bounds);
  const shown = shownTab(workspace);
  const topBar = !!layout.topBar;
  const shownKind = shown && definition.kind(shown.kind);
  const label = definition.label;
  // The panel's resizable edge: where it meets the column, under the top bar when its strip is
  // there, else the whole edge.
  const resize = !expanded && (
    <ResizeHandle
      label={`Resize ${label.toLowerCase()}`}
      edge={bottom ? "top" : "left"}
      size={size}
      min={layout.bounds.min}
      max={layout.bounds.max}
      onResize={(next) =>
        bottom ? actions.setBottomSize(next, false) : actions.setSize(next, false)
      }
      onResizeEnd={(next) =>
        bottom ? actions.setBottomSize(next, true) : actions.setSize(next, true)
      }
    />
  );
  const content = (
    <section
      ref={section}
      aria-label={label}
      data-panel
      data-focus-region="panel"
      onFocus={focusBack.onFocus}
      onBlur={focusBack.onBlur}
      data-edge={bottom ? "bottom" : "right"}
      data-panel-mode={layout.mode}
      style={
        expanded
          ? undefined
          : bottom
            ? { height: size }
            : // However the window is resized, the column keeps its minimum beside the panel.
              { width: size, maxWidth: `calc(100% - ${roomLimits.mainMin}px)` }
      }
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col",
        // In the top bar the strip is on the frame colour, and only the body is on the canvas.
        !topBar && "bg-panel",
        expanded
          ? "h-full flex-1"
          : bottom
            ? // Under the column, the panel carries on the canvas's left hairline.
              "fx-panel-in w-full shrink-0 border-t [[data-sidebar=shown]_&]:border-l"
            : "fx-panel-in shrink-0",
      )}
    >
      {!topBar && resize}
      <div
        className={cn(
          "relative flex h-(--header-h) shrink-0 items-center gap-1 pr-2.5 pl-2",
          // Heading the panel on the canvas, the strip has a hairline under it; in the top bar
          // the canvas's own edge is the line.
          !topBar && toolbarEdge,
          // In full view the strip starts the bar where the header did, clear of the macOS
          // lights; on a phone its Back to chat sits at the edge.
          topBar && expanded && (replace ? "pl-1.5" : "pl-3"),
          // The panel's strip is the window's top row, so it drags the window.
          topBar && "[-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]",
          // The top row's 10px plus, on Windows, the room the window's own min/max/close
          // buttons take (`titleBarOverlay`); elsewhere the env() values make it 10px.
          topBar &&
            "pr-[calc(100vw_-_env(titlebar-area-x,0px)_-_env(titlebar-area-width,100vw)_+_10px)]",
        )}
      >
        {/* Where the column meets the panel docked beside it. */}
        {topBar && !expanded && (
          <span aria-hidden data-boundary="panel" className={boundaryMarker} />
        )}
        {props.leading}
        <TabStrip
          scope={props.scope}
          label={`${label} tabs`}
          state={workspace}
          definition={definition}
          actions={actions}
        />
        {/* The showing tab's own actions. */}
        <div className="flex shrink-0 items-center justify-end gap-0.5">
          {shown && shownKind && (
            <Suspense fallback={null}>
              {createElement(shownKind.actions(), { scope: props.scope, tab: shown })}
            </Suspense>
          )}
        </div>
        {props.controls && (
          <span className="flex items-center">
            <span aria-hidden className={controlDivider} />
            {props.controls}
          </span>
        )}
      </div>
      <div
        className={cn(
          "relative flex min-h-0 flex-1 flex-col",
          // The canvas starts under the top bar: its top hairline, and the one where the panel
          // meets the column (in full view, the sidebar).
          topBar &&
            (expanded
              ? "border-t bg-panel [[data-sidebar=shown]_&]:border-l"
              : "border-t border-l bg-panel"),
        )}
      >
        {topBar && resize}
        {props.notice}
        <Activity mode={workspace.open ? "visible" : "hidden"}>
          <TabContent
            scope={props.scope}
            definition={definition}
            tabs={workspace.tabs}
            shown={shown?.key}
            onClose={actions.close}
          />
        </Activity>
      </div>
    </section>
  );
  // What its views open (a new terminal) opens here, beside them.
  return (
    <Activity mode={workspace.open ? "visible" : "hidden"}>
      <PanelPlaceContext value="side">{content}</PanelPlaceContext>
    </Activity>
  );
}

/**
 * The panel's toggle outside the panel itself (the header's), to return focus to. A panel opened
 * from a tool in the phone's ⋯ still returns to the header's toggle; failing that, to the ⋯.
 */
function toggleOutside(panel: HTMLElement | null): HTMLElement | undefined {
  // Not one inside a popup (the phone's ⋯): that closes, taking focus with it.
  const toggle = [...document.querySelectorAll<HTMLElement>("[data-panel-toggle]")].find(
    (each) => !each.closest('[data-panel], [data-slot="popover-content"], [role="menu"]'),
  );
  return (
    toggle ??
    panel
      ?.closest("[data-workspace]")
      ?.querySelector<HTMLElement>('header button[aria-label="More actions"]') ??
    undefined
  );
}
