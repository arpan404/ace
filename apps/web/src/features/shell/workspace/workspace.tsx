import { ChatCircleTextIcon } from "@phosphor-icons/react";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Tip } from "@/components/ui/tooltip.tsx";
import { overlayPanelsQuery, usePhone } from "@/lib/breakpoints.ts";
import { useMediaQuery } from "@/lib/media.ts";
import { whenIdle } from "@/lib/idle.ts";
import { withViewTransition } from "@/lib/motion.ts";
import {
  usePreferredSize,
  useScopeWorkspace,
  useWorkspaceActions,
  useWorkspaceStore,
  type WorkspaceDefinition,
} from "@/lib/workspace/index.ts";
import { HeaderNav } from "../app-header.tsx";
import { panelBounds } from "./bounds.ts";
import { PanelControls } from "./panel-controls.tsx";
import { useElementSize } from "@/lib/element-size.ts";
import { WorkspaceHotkeys } from "./workspace-hotkeys.tsx";

// The panel (strip, tabs, menus, views) loads the first time it shows, warmed while idle after
// the screen's first paint: the thread route stays within its budget (ADR 0056).
const loadPanel = () => import("./panel.tsx");
const WorkspacePanel = lazy(() => loadPanel().then((m) => ({ default: m.WorkspacePanel })));
const CloseConfirm = lazy(() => loadPanel().then((m) => ({ default: m.CloseConfirm })));

/** Hold the panel back until the kinds (icons, titles, views) have loaded too. */
function WhenKindsReady(props: { definition: WorkspaceDefinition; children: ReactNode }) {
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
    <WhenKindsReady definition={props.definition}>
      <Overlays {...props} />
    </WhenKindsReady>
  );
}

function Overlays(props: { scope: string; definition: WorkspaceDefinition }) {
  return props.definition
    .kinds()
    .map((kind) => (kind.Overlay ? <kind.Overlay key={kind.kind} scope={props.scope} /> : null));
}

/**
 * A screen with a side panel:
 *
 *   ┌ header (main column) ──────────┬ side panel strip ┐
 *   │ main column                    │ side panel       │
 *   └────────────────────────────────┴──────────────────┘
 *
 * In full view the panel fills the row and the main column steps aside (still mounted, so the
 * transcript keeps its place); the strip then carries the header's navigation and a way back to
 * the conversation.
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
  const preferred = usePreferredSize();
  const overlay = useMediaQuery(overlayPanelsQuery, false);
  const sheet = usePhone();
  const outer = useRef<HTMLDivElement>(null);
  const size = useElementSize(outer);
  // Warm the kinds and the panel's code once the screen has painted.
  useEffect(
    () => whenIdle(() => void Promise.all([definition.load(), loadPanel()]).catch(() => {})),
    [definition],
  );
  useEffect(() => {
    store.setFocused(scope);
    return () => {
      if (store.focused === scope) store.setFocused(undefined);
    };
  }, [store, scope]);

  // The panel mounts once it first opens and stays mounted (hidden it renders nothing), so its
  // exit plays and its tab views keep their state.
  const [shown, setShown] = useState(false);
  if (workspace.open && !shown) setShown(true);
  const expanded = workspace.expanded && workspace.open;
  // While the panel shows beside the column, its strip holds the panel's controls.
  const inline = workspace.open && !overlay && !sheet;
  const controls = (placement: "header" | "panel") => (
    <PanelControls workspace={workspace} actions={actions} placement={placement} />
  );
  const leading = expanded && (
    <>
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
      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
    </>
  );
  return (
    <div ref={outer} data-workspace className="relative flex min-h-0 flex-1 flex-col">
      <WorkspaceHotkeys workspace={workspace} definition={definition} actions={actions} />
      <KindOverlays scope={scope} definition={definition} />
      {shown && (
        <Suspense fallback={null}>
          <CloseConfirm />
        </Suspense>
      )}
      <div className="relative flex min-h-0 flex-1">
        {/* In full view the column steps aside but stays mounted: the transcript keeps its place. */}
        <div hidden={expanded} className="relative flex min-w-0 flex-1 flex-col">
          {props.header(inline ? undefined : controls("header"))}
          {props.notice}
          {props.children}
        </div>
        {shown && (
          <Suspense fallback={null}>
            <WhenKindsReady definition={definition}>
              <WorkspacePanel
                scope={scope}
                definition={definition}
                workspace={workspace}
                actions={actions}
                layout={{
                  overlay: overlay && !expanded,
                  sheet,
                  bounds: panelBounds(size.width, overlay),
                  size: workspace.size ?? preferred,
                }}
                leading={leading}
                controls={controls("panel")}
                notice={expanded ? props.notice : undefined}
                context={props.title}
              />
            </WhenKindsReady>
          </Suspense>
        )}
      </div>
    </div>
  );
}
