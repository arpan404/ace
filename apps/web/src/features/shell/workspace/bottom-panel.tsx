import { CaretDownIcon } from "@phosphor-icons/react";
import { Activity, createElement, Suspense, useRef } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ResizeHandle } from "@/components/ui/resize-handle.tsx";
import { controlDivider, toolbarEdge } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";
import {
  bottomOf,
  defaultBottomSize,
  PanelPlaceContext,
  shownTab,
  useBottomHeight,
  useScopeWorkspace,
  useWorkspaceActions,
  type WorkspaceDefinition,
} from "@/lib/workspace/index.ts";
import { useBottomFocus } from "./bottom-focus.ts";
import { BottomTabs } from "./bottom-tabs.tsx";
import { clampToBounds, type Bounds } from "./bounds.ts";
import { TabContent } from "./tab-content.tsx";

/**
 * The bottom panel under the main column: the thread's terminals as tabs, the showing one's own
 * actions (Find, sessions, New terminal, ⋯), Hide, and a top edge to drag. Its height is this
 * device's (`useBottomHeight`). Hiding keeps every tab and shell; the views sit in a hidden
 * Activity and come back as they were. Everything inside acts as the bottom panel
 * (`PanelPlaceContext`), so a terminal opened from here opens here.
 */
export function BottomPanel(props: {
  scope: string;
  definition: WorkspaceDefinition;
  bounds: Bounds;
}) {
  return (
    <PanelPlaceContext value="bottom">
      <Panel {...props} />
    </PanelPlaceContext>
  );
}

function Panel(props: { scope: string; definition: WorkspaceDefinition; bounds: Bounds }) {
  const { scope, definition } = props;
  const actions = useWorkspaceActions(scope);
  const group = bottomOf(useScopeWorkspace(scope));
  const shown = shownTab(group);
  const shownKind = shown && definition.kind(shown.kind);
  const size = clampToBounds(useBottomHeight(), props.bounds);
  const section = useRef<HTMLElement>(null);
  const focus = useBottomFocus(section, group.open);
  const label = definition.bottom?.label ?? "Bottom panel";
  return (
    <Activity mode={group.open ? "visible" : "hidden"}>
      <section
        ref={section}
        aria-label={label}
        data-bottom-panel
        onFocus={focus.onFocus}
        onBlur={focus.onBlur}
        style={{ height: size }}
        className="fx-panel-in relative flex min-h-0 shrink-0 flex-col border-t bg-panel"
        data-edge="bottom"
      >
        <ResizeHandle
          label={`Resize ${label.toLowerCase()}`}
          edge="top"
          size={size}
          min={props.bounds.min}
          max={props.bounds.max}
          onResize={(next) => actions.setBottomHeight(next, false)}
          onResizeEnd={(next) => actions.setBottomHeight(next, true)}
          onReset={() => actions.setBottomHeight(defaultBottomSize, true)}
        />
        <div
          className={cn(
            "flex h-(--row-height) shrink-0 items-center gap-1 pr-1.5 pl-2",
            toolbarEdge,
          )}
        >
          <BottomTabs
            label={`${label} tabs`}
            group={group}
            definition={definition}
            actions={actions}
          />
          <div className="flex shrink-0 items-center justify-end gap-0.5">
            {shown && shownKind && (
              <Suspense fallback={null}>
                {createElement(shownKind.actions(), { scope, tab: shown })}
              </Suspense>
            )}
          </div>
          <span aria-hidden className={controlDivider} />
          <IconButton
            icon={CaretDownIcon}
            label={`Hide ${label.toLowerCase()}`}
            shortcut="terminalPanel"
            size="sm"
            className="size-7"
            onClick={() => actions.setBottomOpen(false)}
          />
        </div>
        <TabContent
          scope={scope}
          definition={definition}
          tabs={group.tabs}
          shown={shown?.key}
          onClose={actions.close}
        />
      </section>
    </Activity>
  );
}
