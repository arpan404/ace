import { ChatCircleTextIcon } from "@phosphor-icons/react";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Tip } from "@/components/ui/tooltip.tsx";
import { overlayPanelsQuery, usePhone } from "@/lib/breakpoints.ts";
import { useMediaQuery } from "@/lib/media.ts";
import { whenIdle } from "@/lib/idle.ts";
import { withViewTransition } from "@/lib/motion.ts";
import {
  usePreferredSizes,
  useScopeWorkspace,
  useWorkspaceActions,
  useWorkspaceStore,
  type WorkspaceDefinition,
} from "@/lib/workspace/index.ts";
import { HeaderNav } from "../app-header.tsx";
import { bottomBounds, rightBounds } from "./bounds.ts";
import { DockControls, loadOpenTabs } from "./dock-controls.tsx";
import { useElementSize } from "@/lib/element-size.ts";
import { WorkspaceHotkeys } from "./workspace-hotkeys.tsx";

// The docks (strip, tabs, menus, views) load the first time one shows, warmed while idle after
// the screen's first paint: the thread route stays within its budget (ADR 0056).
const loadDock = () => import("./dock.tsx");
const WorkspaceDock = lazy(() => loadDock().then((m) => ({ default: m.WorkspaceDock })));
const CloseConfirm = lazy(() => loadDock().then((m) => ({ default: m.CloseConfirm })));

/** Hold the docks back until the kinds (icons, titles, views) have loaded too. */
function DockWhenReady(props: { definition: WorkspaceDefinition; children: ReactNode }) {
  const [ready, setReady] = useState(props.definition.loaded());
  useEffect(() => {
    if (ready) return;
    let live = true;
    props.definition.load().then(
      () => live && setReady(true),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [ready, props.definition]);
  return ready ? props.children : null;
}

/** Each kind's overlay (a palette its shortcut opens), once the kinds have loaded. */
function KindOverlays(props: { scope: string; definition: WorkspaceDefinition }) {
  return (
    <DockWhenReady definition={props.definition}>
      <Overlays {...props} />
    </DockWhenReady>
  );
}

function Overlays(props: { scope: string; definition: WorkspaceDefinition }) {
  return props.definition
    .kinds()
    .map((kind) => (kind.Overlay ? <kind.Overlay key={kind.kind} scope={props.scope} /> : null));
}

/** The header row's height (`--header-h`), which the bottom dock's limit leaves room for. */
const headerHeight = 50;

/**
 * A screen with docks:
 *
 *   ┌ header (main column) ──────────┬ side panel strip ┐
 *   │ main column                    │ side panel       │
 *   ├────────────────────────────────┴──────────────────┤
 *   │ bottom panel (spans both)                         │
 *   └───────────────────────────────────────────────────┘
 *
 * In full view the side panel fills the row and the main column steps aside (still mounted,
 * so the transcript keeps its place); the strip then carries the header's navigation and a way
 * back to the conversation.
 */
export function Workspace(props: {
  scope: string;
  definition: WorkspaceDefinition;
  title: ReactNode;
  header(trailing?: ReactNode): ReactNode;
  notice: ReactNode;
  children: ReactNode;
}) {
  const { scope, definition } = props;
  const store = useWorkspaceStore();
  // Binds the scope to its definition and seeds a scope seen for the first time.
  store.define(scope, definition);
  const workspace = useScopeWorkspace(scope);
  const actions = useWorkspaceActions(scope);
  const preferred = usePreferredSizes();
  const overlay = useMediaQuery(overlayPanelsQuery, false);
  const sheet = usePhone();
  const outer = useRef<HTMLDivElement>(null);
  const size = useElementSize(outer);
  // Warm the kinds and the docks' code once the screen has painted.
  useEffect(
    () =>
      whenIdle(
        () => void Promise.all([definition.load(), loadDock(), loadOpenTabs()]).catch(() => {}),
      ),
    [definition],
  );
  useEffect(() => {
    store.setFocused(scope);
    return () => {
      if (store.focused === scope) store.setFocused(undefined);
    };
  }, [store, scope]);

  // A dock mounts once it first opens and stays mounted (hidden ones render nothing), so its
  // exit plays and its tab views keep their state.
  const [shown, setShown] = useState({ right: false, bottom: false });
  if ((workspace.right.open && !shown.right) || (workspace.bottom.open && !shown.bottom))
    setShown({
      right: shown.right || workspace.right.open,
      bottom: shown.bottom || workspace.bottom.open,
    });
  const expanded = workspace.expanded && workspace.right.open;
  // While the side panel shows beside the column, its strip holds the dock toggles.
  const rightInline = workspace.right.open && !overlay && !sheet;
  const hasBottom = definition.docks.includes("bottom");
  const controls = (placement: "header" | "panel") => (
    <DockControls
      scope={scope}
      workspace={workspace}
      definition={definition}
      actions={actions}
      placement={placement}
      bottom={hasBottom}
    />
  );
  const leading = expanded && (
    <>
      <HeaderNav />
      <Tip label="Back to the conversation" shortcut="fullView">
        <button
          type="button"
          onClick={() => withViewTransition(() => actions.setExpanded(false))}
          className="ml-1 flex h-7 max-w-[220px] min-w-0 shrink-0 items-center gap-1.5 rounded-[7px] px-2.5 text-sm font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)] [-webkit-app-region:no-drag]"
        >
          <ChatCircleTextIcon aria-hidden size={14} className="shrink-0" />
          <span className="min-w-0 truncate">{props.title}</span>
        </button>
      </Tip>
      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
    </>
  );
  return (
    <div ref={outer} className="relative flex min-h-0 flex-1 flex-col">
      <WorkspaceHotkeys workspace={workspace} definition={definition} actions={actions} />
      <KindOverlays scope={scope} definition={definition} />
      {(shown.right || shown.bottom) && (
        <Suspense fallback={null}>
          <CloseConfirm />
        </Suspense>
      )}
      <div className="relative flex min-h-0 flex-1">
        {/* In full view the column steps aside but stays mounted: the transcript keeps its place. */}
        <div hidden={expanded} className="relative flex min-w-0 flex-1 flex-col">
          {props.header(rightInline ? undefined : controls("header"))}
          {props.notice}
          {props.children}
        </div>
        {shown.right && (
          <Suspense fallback={null}>
            <DockWhenReady definition={definition}>
              <WorkspaceDock
                side="right"
                scope={scope}
                definition={definition}
                workspace={workspace}
                actions={actions}
                layout={{
                  overlay: overlay && !expanded,
                  sheet,
                  bounds: rightBounds(size.width, overlay),
                  size: workspace.right.size ?? preferred.right,
                }}
                leading={leading}
                controls={controls("panel")}
                notice={expanded ? props.notice : undefined}
              />
            </DockWhenReady>
          </Suspense>
        )}
      </div>
      {hasBottom && shown.bottom && (
        <Suspense fallback={null}>
          <DockWhenReady definition={definition}>
            <WorkspaceDock
              side="bottom"
              scope={scope}
              definition={definition}
              workspace={workspace}
              actions={actions}
              layout={{
                overlay,
                sheet,
                bounds: bottomBounds(size.height - headerHeight),
                size: workspace.bottom.size ?? preferred.bottom,
              }}
            />
          </DockWhenReady>
        </Suspense>
      )}
    </div>
  );
}
