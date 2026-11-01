import { Activity, createElement, Suspense, useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { ResizeHandle } from "@/components/ui/resize-handle.tsx";
import { cn } from "@/lib/cn.ts";
import { controlDivider, toolbarEdge } from "@/components/ui/rules.ts";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet.tsx";
import { useLayout } from "@/lib/layout.tsx";
import {
  PanelPlaceContext,
  shownTab,
  type ScopeWorkspace,
  type WorkspaceActions,
  type WorkspaceDefinition,
} from "@/lib/workspace/index.ts";
import { findComposerInput } from "@/lib/focus-composer.ts";
import { clampToBounds, type Bounds } from "./bounds.ts";
import { useFocusBackOnHide } from "./panel-focus.ts";
import { TabContent } from "./tab-content.tsx";

// The close question ships with the panel: a tab can only be closed once the panel has loaded.
export { CloseConfirm } from "./close-confirm.tsx";
import { TabStrip } from "./tab-strip.tsx";

export interface PanelLayout {
  dock?: "side" | "bottom";
  /** Narrow window: the panel floats over the content, which dims; Escape or a click outside hides it. */
  overlay: boolean;
  /**
   * Phone: the panel is a sheet over the whole screen bar a dimmed strip at the top. Done,
   * Escape or a tap on the strip closes it.
   */
  sheet: boolean;
  /**
   * Docked beside the column, or in full view: the panel runs the window's full height and its
   * strip is the top bar's part above it, on the frame colour; its body starts the canvas.
   */
  topBar?: boolean;
  bounds: Bounds;
  /** The width this scope remembers, or the preferred one. */
  size: number;
}

/**
 * The side panel: its strip (tabs, +, the showing tab's actions, the panel's controls), its tab
 * views and its resize edge. Docked beside the column or in full view, the strip is the window's
 * top bar above the panel; elsewhere it heads the panel on the canvas or in its sheet. Desktop layout changes once, without an exit reservation.
 * Floating layouts use the shared modal Sheet; hidden Activity preserves tab state.
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
  /** As a sheet, which covers the screen: what it belongs to (the thread's title). */
  context?: ReactNode;
  restoreFocus?(): HTMLElement | null;
}) {
  const { workspace, actions, definition, layout } = props;
  const expanded = workspace.expanded;
  const bottom = layout.dock === "bottom";
  const { setRightPanel } = useLayout();
  const floating = layout.overlay && !layout.sheet;
  // Over the content, it closes like any overlay: Escape or a tap outside it.
  const dismissable = floating || layout.sheet;
  useEffect(() => {
    if (!workspace.open) return;
    setRightPanel(() => actions.setOpen(false));
    return () => setRightPanel(undefined);
  }, [workspace.open, setRightPanel, actions]);
  const section = useRef<HTMLElement>(null);
  const dismiss = () => actions.setOpen(false);
  const restoreFocus = () => toggleOutside(section.current) ?? props.restoreFocus?.() ?? false;
  // Beside the column, hiding the panel with focus in it hands focus to the composer.
  const focusBack = useFocusBackOnHide(section, workspace.open, restoreFocus);
  const size = clampToBounds(layout.size, layout.bounds);
  const shown = shownTab(workspace);
  const topBar = !!layout.topBar;
  // Floating over a desktop column, or as the top bar's part above a docked panel, the strip is
  // the window's top row.
  const topRow = floating || topBar;
  const shownKind = shown && definition.kind(shown.kind);
  const label = definition.label;
  // The panel's resizable edge: where it meets the column, under the top bar when its strip is
  // there, else the whole edge.
  const resize = !dismissable && !expanded && (
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
      onFocus={dismissable ? undefined : focusBack.onFocus}
      onBlur={dismissable ? undefined : focusBack.onBlur}
      data-edge={layout.sheet || bottom ? "bottom" : "right"}
      style={dismissable || expanded ? undefined : bottom ? { height: size } : { width: size }}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col",
        // In the top bar the strip is on the frame colour, and only the body is on the canvas.
        !topBar && "bg-panel",
        dismissable || expanded
          ? "h-full flex-1"
          : bottom
            ? // Under the column, the panel carries on the canvas's left hairline.
              "fx-panel-in w-full shrink-0 border-t [[data-sidebar=shown]_&]:border-l"
            : topBar
              ? "fx-panel-in shrink-0"
              : "fx-panel-in shrink-0 border-l",
      )}
    >
      {layout.sheet && (
        <>
          <span aria-hidden className="mx-auto mt-1.5 h-1 w-9 shrink-0 rounded-full bg-border" />
          {props.context && (
            <p className="shrink-0 truncate px-4 pt-1 text-xs text-muted-foreground">
              {props.context}
            </p>
          )}
        </>
      )}
      {!topBar && resize}
      <div
        className={cn(
          "flex h-(--header-h) shrink-0 items-center gap-1 pr-2.5 pl-2",
          // Heading the panel on the canvas, the strip has a hairline under it; in the top bar
          // the canvas's own edge is the line.
          !topBar && toolbarEdge,
          !layout.sheet && !bottom && !topBar && "bg-reading",
          // In full view the strip starts the bar where the header did, clear of the macOS lights.
          topBar && expanded && "pl-3",
          // The panel's strip is the window's top row, so it drags the window.
          topRow && "[-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]",
          // The top row's 10px plus, on Windows, the room the window's own min/max/close
          // buttons take (`titleBarOverlay`); elsewhere the env() values make it 10px.
          topRow &&
            "pr-[calc(100vw_-_env(titlebar-area-x,0px)_-_env(titlebar-area-width,100vw)_+_10px)]",
          layout.sheet && "h-12 pr-1.5",
        )}
      >
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
        {layout.sheet ? (
          // A sheet has one way out, in reach of a thumb; the toggle and full view do nothing
          // useful over a phone's whole screen.
          <Button variant="ghost" className="h-11 min-w-11 shrink-0 px-3" onClick={dismiss}>
            Done
          </Button>
        ) : (
          props.controls && (
            <span className="flex items-center">
              <span aria-hidden className={controlDivider} />
              {props.controls}
            </span>
          )
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
  const placed = <PanelPlaceContext value="side">{content}</PanelPlaceContext>;
  if (dismissable) {
    return (
      <Sheet open={workspace.open} onOpenChange={(open) => actions.setOpen(open)}>
        <SheetContent
          side={layout.sheet ? "bottom" : "right"}
          keepMounted
          hidden={!workspace.open}
          showCloseButton={false}
          // Floating beside a desktop column, back to the composer; a phone's sheet goes back to
          // its toggle, so closing it never raises the keyboard.
          finalFocus={() => (!layout.sheet && findComposerInput()) || restoreFocus()}
          initialFocus={() =>
            section.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
            false
          }
          style={layout.sheet ? undefined : { width: size }}
          className={cn(
            "gap-0 overflow-hidden transition-none sm:max-w-none",
            layout.sheet && "data-[side=bottom]:h-[calc(100dvh-0.75rem)] rounded-t-xl",
          )}
        >
          <SheetTitle className="sr-only">{label}</SheetTitle>
          <Activity mode={workspace.open ? "visible" : "hidden"}>{placed}</Activity>
        </SheetContent>
      </Sheet>
    );
  }
  return <Activity mode={workspace.open ? "visible" : "hidden"}>{placed}</Activity>;
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
