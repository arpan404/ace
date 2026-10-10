import { Activity, createElement, Suspense, useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { ResizeHandle } from "@/components/ui/resize-handle.tsx";
import { cn } from "@/lib/cn.ts";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet.tsx";
import { useLayout } from "@/lib/layout.tsx";
import {
  shownTab,
  type ScopeWorkspace,
  type WorkspaceActions,
  type WorkspaceDefinition,
} from "@/lib/workspace/index.ts";
import { clampToBounds, type Bounds } from "./bounds.ts";
import { TabContent } from "./tab-content.tsx";

// The close question ships with the panel: a tab can only be closed once the panel has loaded.
export { CloseConfirm } from "./close-confirm.tsx";
import { TabStrip } from "./tab-strip.tsx";

export interface PanelLayout {
  /** Narrow window: the panel floats over the content, which dims; Escape or a click outside hides it. */
  overlay: boolean;
  /**
   * Phone: the panel is a sheet over the whole screen bar a dimmed strip at the top. Done,
   * Escape or a tap on the strip closes it.
   */
  sheet: boolean;
  bounds: Bounds;
  /** The width this scope remembers, or the preferred one. */
  size: number;
}

/**
 * The side panel: its strip (tabs, +, the showing tab's actions, the panel's controls), its tab
 * views and its resize edge. Desktop layout changes once, without an exit reservation.
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
  const size = clampToBounds(layout.size, layout.bounds);
  const shown = shownTab(workspace);
  // The panel's strip is the window's top row (a sheet starts below the top edge).
  const topRow = !layout.sheet;
  const shownKind = shown && definition.kind(shown.kind);
  const label = definition.label;
  const content = (
    <section
      ref={section}
      aria-label={label}
      data-panel
      data-edge={layout.sheet ? "bottom" : "right"}
      style={dismissable || expanded ? undefined : { width: size }}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col bg-panel",
        dismissable || expanded ? "h-full flex-1" : "shrink-0 border-l",
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
      {!dismissable && !expanded && (
        <ResizeHandle
          label={`Resize ${label.toLowerCase()}`}
          edge="left"
          size={size}
          min={layout.bounds.min}
          max={layout.bounds.max}
          onResize={(next) => actions.setSize(next, false)}
          onResizeEnd={(next) => actions.setSize(next, true)}
        />
      )}
      <div
        className={cn(
          // A box-shadow hairline, not a border: the strip's controls sit on its exact centre line.
          "flex h-(--header-h) shrink-0 items-center gap-1 pr-2.5 pl-2 shadow-[inset_0_-1px_0_var(--border)]",
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
            <>
              <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
              {props.controls}
            </>
          )
        )}
      </div>
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
    </section>
  );
  if (dismissable) {
    return (
      <Sheet open={workspace.open} onOpenChange={(open) => actions.setOpen(open)}>
        <SheetContent
          side={layout.sheet ? "bottom" : "right"}
          keepMounted
          hidden={!workspace.open}
          showCloseButton={false}
          finalFocus={restoreFocus}
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
          <Activity mode={workspace.open ? "visible" : "hidden"}>{content}</Activity>
        </SheetContent>
      </Sheet>
    );
  }
  return <Activity mode={workspace.open ? "visible" : "hidden"}>{content}</Activity>;
}

/**
 * The panel's toggle outside the panel itself (the header's), to return focus to. On a phone the
 * toggle lives in this screen's header ⋯, closed by now: focus goes back to that ⋯.
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
