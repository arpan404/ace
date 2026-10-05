import {
  ArrowsInLineVerticalIcon,
  ArrowsOutLineVerticalIcon,
  CaretDownIcon,
} from "@phosphor-icons/react";
import { createElement, Suspense, useEffect, type ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ResizeHandle } from "@/components/ui/resize-handle.tsx";
import { cn } from "@/lib/cn.ts";
import { useHotkey } from "@/lib/hotkeys.ts";
import { useLayout } from "@/lib/layout.tsx";
import { panelMotion, usePresence } from "@/lib/motion.ts";
import {
  shownTab,
  type Dock,
  type ScopeWorkspace,
  type WorkspaceActions,
  type WorkspaceDefinition,
} from "@/lib/workspace/index.ts";
import { clampToBounds, type Bounds } from "./bounds.ts";
import { TabContent } from "./tab-content.tsx";

// The close question ships with the docks: a tab can only be closed once its dock has loaded.
export { CloseConfirm } from "./close-confirm.tsx";
import { TabStrip } from "./tab-strip.tsx";

/** The floating dock's scrim and leading-edge shadow (inline: one-off values, ADR 0056 CSS budget). */
const scrim = { background: "color-mix(in oklab, black 40%, transparent)" };
const edgeShadow = {
  right: { boxShadow: "-16px 0 40px -12px rgb(0 0 0 / 0.45)" },
  bottom: { boxShadow: "0 -16px 40px -12px rgb(0 0 0 / 0.45)" },
};

export interface DockLayout {
  /** Narrow window: the dock floats over the content, which dims; Escape or a click outside hides it. */
  overlay: boolean;
  /** Phone: the dock is a sheet over the whole screen. */
  sheet: boolean;
  bounds: Bounds;
  /** The size this scope remembers, or the preferred one. */
  size: number;
}

/**
 * One dock: its strip (tabs, +, the showing tab's actions, the dock's own controls), its tab
 * views and its resize edge. The right dock's strip shares the header row; the bottom dock spans
 * the main column and the right dock. Opening slides it in from its edge, hiding fades it out
 * before the column reflows, and hidden it keeps its tabs.
 */
export function WorkspaceDock(props: {
  side: Dock;
  scope: string;
  definition: WorkspaceDefinition;
  workspace: ScopeWorkspace;
  actions: WorkspaceActions;
  layout: DockLayout;
  /** Before the tabs: the header's navigation in full view. */
  leading?: ReactNode;
  /** After the tabs: the dock toggles (right) . */
  controls?: ReactNode;
  /** Under the strip: the connection notice in full view. */
  notice?: ReactNode;
}) {
  const { side, workspace, actions, definition, layout } = props;
  const state = workspace[side];
  const right = side === "right";
  const expanded = right && workspace.expanded;
  const maximized = !right && workspace.bottomMaximized;
  const { setRightPanel } = useLayout();
  const presence = usePresence(state.open);
  const closing = presence.phase === "exit";
  const floating = layout.overlay && !layout.sheet;
  const hide = () => actions.setOpen(side, false);
  useEffect(() => {
    if (!right || !state.open) return;
    setRightPanel(() => actions.setOpen("right", false));
    return () => setRightPanel(undefined);
  }, [right, state.open, setRightPanel, actions]);
  // Floating, it closes like any overlay: Escape or a click on the scrim, and focus goes back
  // to the toggle that opened it rather than to the page.
  const dismiss = () => {
    hide();
    toggleOutside(side)?.focus();
  };
  useHotkey("escape", dismiss, { enabled: floating && state.open });
  if (!presence.mounted) return null;

  const size = maximized ? layout.bounds.max : clampToBounds(layout.size, layout.bounds);
  const shown = shownTab(state);
  const shownKind = shown && definition.kind(shown.kind);
  const label = right ? definition.label : "Bottom panel";
  return (
    <>
      {floating && (
        <div
          aria-hidden
          data-scrim
          onClick={dismiss}
          style={scrim}
          className={cn(
            "absolute inset-0 z-20",
            closing ? "fx-fade-out" : presence.toggled && "fx-fade-in",
          )}
        />
      )}
      <section
        aria-label={closing ? undefined : label}
        inert={closing}
        data-dock={side}
        data-edge={right && !layout.sheet ? "right" : "bottom"}
        style={{
          ...(layout.sheet || expanded ? undefined : right ? { width: size } : { height: size }),
          ...(floating ? (right ? edgeShadow.right : edgeShadow.bottom) : undefined),
        }}
        className={cn(
          "relative flex min-h-0 min-w-0 flex-col bg-panel",
          expanded ? "flex-1" : "shrink-0",
          layout.sheet
            ? "absolute inset-0 z-30 rounded-t-xl border-t bg-background shadow-[0_-12px_32px_rgb(0_0_0/0.22)]"
            : [
                right ? !expanded && "border-l" : "border-t",
                layout.overlay &&
                  // Over the scrim, with an elevation shadow on its leading edge (`edgeShadow`).
                  (right
                    ? "absolute inset-y-0 right-0 z-20 max-w-[calc(100%-3rem)] bg-background"
                    : "absolute inset-x-0 bottom-0 z-20 bg-background"),
              ],
          panelMotion(presence),
        )}
      >
        {!layout.sheet && !expanded && (
          <ResizeHandle
            label={`Resize ${label.toLowerCase()}`}
            edge={right ? "left" : "top"}
            size={size}
            min={layout.bounds.min}
            max={layout.bounds.max}
            onResize={(next) => {
              if (maximized) actions.setBottomMaximized(false);
              actions.setSize(side, next, false);
            }}
            onResizeEnd={(next) => actions.setSize(side, next, true)}
          />
        )}
        <div
          className={cn(
            // A box-shadow hairline, not a border: the strip's controls sit on its exact centre line.
            "flex shrink-0 items-center gap-1 shadow-[inset_0_-1px_0_var(--border)] [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]",
            // The side panel's strip is the header row above it: same height, same centre line.
            right ? "h-(--header-h) pr-2.5 pl-2" : "h-10 pr-1.5 pl-2",
            layout.sheet && "h-12",
          )}
        >
          {props.leading}
          <TabStrip
            scope={props.scope}
            dock={side}
            label={right ? `${label} tabs` : "Bottom panel tabs"}
            state={state}
            definition={definition}
            actions={actions}
          />
          {/* The showing tab's own actions, in a zone at least three buttons wide so the
              dock's controls after it never move as tabs change. */}
          <div
            className={cn("flex shrink-0 items-center justify-end gap-0.5", !right && "min-w-22")}
          >
            {shown && shownKind && (
              <Suspense fallback={null}>
                {createElement(shownKind.actions(), { scope: props.scope, tab: shown, dock: side })}
              </Suspense>
            )}
          </div>
          {right ? (
            props.controls && (
              <>
                <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
                {props.controls}
              </>
            )
          ) : (
            <>
              <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
              <IconButton
                icon={maximized ? ArrowsInLineVerticalIcon : ArrowsOutLineVerticalIcon}
                label={maximized ? "Restore bottom panel" : "Maximize bottom panel"}
                size="sm"
                className="size-7"
                onClick={() => actions.setBottomMaximized(!maximized)}
              />
              <IconButton
                icon={CaretDownIcon}
                label="Hide bottom panel"
                shortcut="bottomPanel"
                size="sm"
                className="size-7"
                onClick={hide}
              />
            </>
          )}
        </div>
        {props.notice}
        <TabContent
          scope={props.scope}
          dock={side}
          definition={definition}
          tabs={state.tabs}
          shown={shown?.key}
          onClose={actions.close}
        />
      </section>
    </>
  );
}

/** The dock's toggle outside the dock itself (the header's), to return focus to. */
function toggleOutside(side: Dock): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>(`[data-dock-toggle="${side}"]`)].find(
    (toggle) => !toggle.closest("[data-dock]"),
  );
}
