import {
  CaretLeftIcon,
  ChatCircleTextIcon,
  SquareSplitHorizontalIcon,
} from "@phosphor-icons/react";
import { Activity, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { LocalBoundary } from "@/components/ui/local-boundary.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useHandheld, useWindowWidth } from "@/lib/breakpoints.ts";
import { clampSize } from "@/components/ui/resize-handle.tsx";
import { railWidth, sidebarWidths, useLayout } from "@/lib/layout.tsx";
import { allocateRoom } from "@/lib/shell-room.ts";
import { whenIdle } from "@/lib/idle.ts";
import { withViewTransition } from "@/lib/motion.ts";
import {
  usePreferredSize,
  useScopeWorkspace,
  useWorkspaceActions,
  useWorkspaceStore,
  type WorkspaceDefinition,
} from "@/lib/workspace/index.ts";
import { cn } from "@/lib/cn.ts";
import { HeaderNav } from "../app-header.tsx";
import { useViewFrame } from "../sidebar-frame.tsx";
import { canvasClass } from "../canvas.ts";
import { bottomBounds } from "./bounds.ts";
import { PanelControls } from "./panel-controls.tsx";
import { useElementSize } from "@/lib/element-size.ts";
import { WorkspaceHotkeys } from "./workspace-hotkeys.tsx";
import { focusPanelSoon } from "./panel-focus.ts";
import { WorkspaceWebLinks } from "./web-link-opener.tsx";

// The panel (strip, tabs, menus, views) loads the first time it shows, warmed while idle after
// the screen's first paint: the thread route stays within its budget (ADR 0056).
const loadPanel = () => import("./panel.tsx");
const WorkspacePanel = deferredComponent(() => loadPanel().then((m) => m.WorkspacePanel));
const CloseConfirm = deferredComponent(() => loadPanel().then((m) => m.CloseConfirm));
const BottomPanel = deferredComponent(() =>
  import("./bottom-panel.tsx").then((m) => m.BottomPanel),
);

/** Hold the panel back until the kinds (icons, titles, views) have loaded too. */
export function WhenKindsReady(props: {
  definition: WorkspaceDefinition;
  children: ReactNode;
  visible?: boolean;
}) {
  // Kept out of the compiler: `loaded()` reads the definition's load state, which changes
  // without the definition itself changing, so a memoized read would wait forever.
  "use no memo";
  const definition = props.definition;
  const ready = definition.loaded();
  const [, invalidate] = useState(0);
  const [failed, setFailed] = useState<WorkspaceDefinition>();
  const error = failed === definition;
  useEffect(() => {
    if (ready) return;
    let live = true;
    definition.load().then(
      () => live && invalidate((value) => value + 1),
      () => live && setFailed(definition),
    );
    return () => {
      live = false;
    };
  }, [ready, definition]);
  if (ready) return props.children;
  if (!props.visible) return null;
  if (!error)
    return (
      // The panel's shape while its tools load: a row of tabs over a few lines.
      <div
        role="status"
        aria-label="Loading tools"
        className="absolute inset-y-0 right-0 z-20 flex w-72 flex-col gap-4 border-l bg-panel p-3"
      >
        <span className="flex gap-1.5">
          <Skeleton className="h-6 w-20 rounded-sm" />
          <Skeleton className="h-6 w-16 rounded-sm" />
        </span>
        <SkeletonText lines={3} className="px-1" />
      </div>
    );
  return (
    <div
      role="alert"
      className="absolute inset-y-0 right-0 z-20 flex w-72 flex-col items-center justify-center gap-3 border-l bg-panel p-4 text-sm"
    >
      Tools couldn't load.
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          setFailed(undefined);
          void definition.load().then(
            () => invalidate((value) => value + 1),
            () => setFailed(definition),
          );
        }}
      >
        Try again
      </Button>
    </div>
  );
}

/** Each kind's overlay (a palette its shortcut opens), once the kinds have loaded. */
function KindOverlays(props: { scope: string; definition: WorkspaceDefinition }) {
  return (
    <WhenKindsReady definition={props.definition}>
      <Overlays {...props} />
    </WhenKindsReady>
  );
}

function Overlays(props: { scope: string; definition: WorkspaceDefinition }) {
  return props.definition.kinds().map((kind) =>
    kind.Overlay ? (
      <LocalBoundary key={kind.kind} label={kind.label} fallback={null}>
        <kind.Overlay scope={props.scope} />
      </LocalBoundary>
    ) : null,
  );
}

/**
 * A screen with a side panel, and a bottom panel (terminals) under the main column:
 *
 *   ┌ header (the column's part of the top bar) ┬ side panel strip ┐
 *   ╭ canvas ───────────────────────────────────┼──────────────────┤
 *   │ main column                               │ side panel       │
 *   ├ bottom panel ─────────────────────────────┤                  │
 *   └───────────────────────────────────────────┴──────────────────┘
 *
 * The panel always docks; nothing floats over the chat. How the width is shared is
 * `allocateRoom`'s: beside the column at every desktop width (the sidebar steps aside first,
 * then the panel narrows, the column keeping its minimum), under it when docked at the bottom,
 * and in the column's place on a phone-sized window.
 *
 * While the side panel is docked open beside the column it runs the window's full height, and
 * its strip is the top bar's part above it, ending with the panel's toggle: the bar splits at
 * the panel's edge and follows it as the panel is resized. Closed or docked at the bottom, the
 * column's header spans the width with the toggle at its right. In full view, and on a phone,
 * the panel takes the canvas and its strip the whole bar, while the main column steps aside
 * (still mounted, so the transcript keeps its place); the strip then leads with a way back to
 * the conversation.
 */
export function Workspace(props: {
  scope: string;
  definition: WorkspaceDefinition;
  title: ReactNode;
  header(trailing?: ReactNode): ReactNode;
  notice: ReactNode;
  children: ReactNode;
  contextPanel?: ReactNode;
}) {
  const { scope, definition } = props;
  const store = useWorkspaceStore();
  // Binds the scope to its definition and seeds a scope seen for the first time.
  store.define(scope, definition);
  const workspace = useScopeWorkspace(scope);
  const actions = useWorkspaceActions(scope);
  const preferred = usePreferredSize();
  const { layout } = useLayout();
  const frame = useViewFrame();
  // The bottom panel wants a fine pointer and a column with room under it: on a phone or a touch
  // screen, terminals open in the side panel.
  const handheld = useHandheld();
  const bottomFits = !!definition.bottom && !handheld;
  const outer = useRef<HTMLDivElement>(null);
  const size = useElementSize(outer);
  // Where the panel goes and how wide it is, as if open: shown or hidden, it keeps its place.
  // The sidebar frame steps the sidebar aside by the same rule, so the two agree.
  const room = allocateRoom({
    window: useWindowWidth(),
    sidebar: {
      open: layout.sidebarOpen,
      inline: frame.hasSidebar && !frame.sheet,
      width: clampSize(layout.sidebarWidth, sidebarWidths.min, sidebarWidths.max) + railWidth,
    },
    panel: {
      open: true,
      dock: workspace.dock === "bottom" ? "bottom" : "side",
      expanded: workspace.expanded,
      size: workspace.size ?? preferred,
    },
  });
  // Asked as if open, so never "closed".
  const place = room.mode === "closed" ? "beside" : room.mode;
  const bottom = place === "bottom";
  const phone = place === "replace";
  // Warm the kinds and the panel's code once the screen has painted.
  useEffect(
    () => whenIdle(() => void Promise.all([definition.load(), loadPanel()]).catch(() => {})),
    [definition],
  );
  useEffect(() => {
    store.setBottomFits(bottomFits);
    return () => store.setBottomFits(false);
  }, [store, bottomFits]);
  useEffect(() => {
    store.setFocused(scope);
    return () => {
      if (store.focused === scope) store.setFocused(undefined);
    };
  }, [store, scope]);

  // Keep tab state after the first open; hidden Activity boundaries pause tool effects.
  const [shown, setShown] = useState(false);
  if (workspace.open && !shown) setShown(true);
  const [bottomShown, setBottomShown] = useState(false);
  if (workspace.bottom?.open && !bottomShown) setBottomShown(true);
  // In full view or on a phone the panel takes the canvas, the column stepping aside.
  const expanded = workspace.open && (place === "full" || phone);
  // The panel's strip is the top bar's part above it: beside the column or in the canvas. Docked
  // at the bottom it heads the panel.
  const topBar = workspace.open && !bottom;
  // On a phone the column's header (and its toggle) steps aside: focus follows into the panel.
  const replacing = workspace.open && phone;
  const wasReplacing = useRef(replacing);
  useEffect(() => {
    const was = wasReplacing.current;
    wasReplacing.current = replacing;
    if (replacing && !was) return focusPanelSoon(outer.current);
  }, [replacing]);
  const controls = (placement: "header" | "panel" | "top bar") => (
    <PanelControls
      workspace={workspace}
      actions={actions}
      placement={placement}
      dockable={definition.dockable}
      mobileTools={definition.mobileTools?.map((tool) => ({
        label: tool.label,
        icon: definition.kind(tool.kind)?.icon ?? SquareSplitHorizontalIcon,
        shortcut: definition.shortcut(tool.kind),
        onClick: () => actions.open({ kind: tool.kind }),
      }))}
    />
  );
  const leading = phone ? (
    // A phone's way back to the chat leads the strip, in reach of a thumb.
    <button
      type="button"
      aria-label="Back to chat"
      onClick={() => actions.setOpen(false)}
      className="focus-ring flex h-9 shrink-0 items-center gap-0.5 rounded-sm pr-2 pl-1 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <CaretLeftIcon aria-hidden size={16} className="shrink-0" />
      Chat
    </button>
  ) : (
    expanded && (
      <>
        {/* The column's header has stepped aside: its way back and forward comes along. */}
        <HeaderNav />
        <Tip label="Back to the conversation" shortcut="fullView">
          <button
            type="button"
            onClick={() => withViewTransition(() => actions.setExpanded(false))}
            className="focus-ring ml-1 flex h-7 max-w-[220px] min-w-0 shrink-0 items-center gap-1.5 rounded-sm px-2.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]"
          >
            <ChatCircleTextIcon aria-hidden size={14} className="shrink-0" />
            <span className="min-w-0 truncate">{props.title}</span>
          </button>
        </Tip>
      </>
    )
  );
  return (
    <WorkspaceWebLinks scope={scope} definition={definition}>
      <div ref={outer} data-workspace className="relative flex min-h-0 flex-1 flex-col">
        <WorkspaceHotkeys
          workspace={workspace}
          definition={definition}
          actions={actions}
          root={() => outer.current}
        />
        <KindOverlays scope={scope} definition={definition} />
        {(shown || bottomShown) && (
          <LocalBoundary label="the close confirmation" fallback={null}>
            <Suspense fallback={null}>
              <CloseConfirm.Component />
            </Suspense>
          </LocalBoundary>
        )}
        <div className={cn("relative flex min-h-0 flex-1", bottom && !expanded && "flex-col")}>
          {/* In full view the column steps aside but stays mounted: the transcript keeps its place. */}
          <div
            hidden={expanded}
            // Beside a docked panel the header stops at the panel's edge, short of the window's.
            data-beside-panel={topBar || undefined}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
          >
            {props.header(topBar ? undefined : controls("header"))}
            <div className={`${canvasClass} flex-col`}>
              <div className="@container/work-body relative flex min-h-0 min-w-0 flex-1 flex-col">
                {props.notice}
                {props.contextPanel ? (
                  <div className="flex min-h-0 flex-1 flex-col @min-[832px]/work-body:flex-row">
                    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                      {props.children}
                    </div>
                    <Activity mode={workspace.open ? "hidden" : "visible"}>
                      {props.contextPanel}
                    </Activity>
                  </div>
                ) : (
                  props.children
                )}
                {/* Under the conversation only: the side panel keeps the window's full height. */}
                {bottomFits && bottomShown && (
                  <Suspense fallback={null}>
                    <WhenKindsReady definition={definition}>
                      <BottomPanel.Component
                        scope={scope}
                        definition={definition}
                        bounds={bottomBounds(size.height)}
                      />
                    </WhenKindsReady>
                  </Suspense>
                )}
              </div>
            </div>
          </div>
          {shown && (
            <Suspense fallback={null}>
              <WhenKindsReady definition={definition} visible={workspace.open}>
                <WorkspacePanel.Component
                  scope={scope}
                  definition={definition}
                  workspace={workspace}
                  actions={actions}
                  layout={{
                    mode: place,
                    topBar,
                    bounds: bottom
                      ? { min: 180, max: Math.max(180, size.height * 0.75) }
                      : room.bounds,
                    size: bottom ? (workspace.bottomSize ?? 360) : room.panel,
                  }}
                  leading={leading}
                  // On a phone Back to chat is the way out; full view and the toggle mean nothing
                  // when the panel already has the whole canvas.
                  controls={phone ? undefined : controls(topBar ? "top bar" : "panel")}
                  notice={expanded ? props.notice : undefined}
                  restoreFocus={() =>
                    outer.current?.querySelector<HTMLElement>(
                      'header button[aria-label="More actions"]',
                    ) ?? null
                  }
                />
              </WhenKindsReady>
            </Suspense>
          )}
        </div>
      </div>
    </WorkspaceWebLinks>
  );
}
