import { ChatCircleTextIcon } from "@phosphor-icons/react";
import { useEffect, useRef, type ReactNode } from "react";
import { Tip } from "@/components/ui/tooltip.tsx";
import { overlayPanelsQuery, usePhone } from "@/lib/breakpoints.ts";
import { useMediaQuery } from "@/lib/media.ts";
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
import { DockControls } from "./dock-controls.tsx";
import { WorkspaceDock } from "./dock.tsx";
import { useElementSize } from "./use-size.ts";
import { WorkspaceHotkeys } from "./workspace-hotkeys.tsx";

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
  useEffect(() => {
    store.setFocused(scope);
    return () => {
      if (store.focused === scope) store.setFocused(undefined);
    };
  }, [store, scope]);

  const expanded = workspace.expanded && workspace.right.open;
  // While the side panel shows beside the column, its strip holds the dock toggles.
  const rightInline = workspace.right.open && !overlay && !sheet;
  const hasBottom = definition.kinds.some((kind) => kind.docks.includes("bottom"));
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
      <div className="relative flex min-h-0 flex-1">
        {/* In full view the column steps aside but stays mounted: the transcript keeps its place. */}
        <div hidden={expanded} className="relative flex min-w-0 flex-1 flex-col">
          {props.header(rightInline ? undefined : controls("header"))}
          {props.notice}
          {props.children}
        </div>
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
      </div>
      {hasBottom && (
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
      )}
    </div>
  );
}
