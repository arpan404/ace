import {
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  SquareSplitHorizontalIcon,
  SquareSplitVerticalIcon,
} from "@phosphor-icons/react";
import { Fragment, type ReactNode } from "react";
import type { KeymapId } from "@/lib/keymap.ts";
import type { IconGlyph } from "@/components/icon.tsx";
import { usePhone } from "@/lib/breakpoints.ts";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { withViewTransition } from "@/lib/motion.ts";
import type { ScopeWorkspace, WorkspaceActions } from "@/lib/workspace/index.ts";

export interface PanelControlAction {
  icon: IconGlyph;
  label: string;
  shortcut?: KeymapId | undefined;
  onClick(): void;
}

/**
 * The side panel's controls: its toggle at the far right of the window's top bar, always, and
 * full view (and the dock choice) at the end of the panel's strip while it shows. Where the
 * strip is itself the top bar's right part (the panel docked beside the column, or in full
 * view), the toggle ends the strip.
 */
export function PanelControls(props: {
  workspace: ScopeWorkspace;
  actions: WorkspaceActions;
  /**
   * `header`: the toggle alone, at the column header's right. `panel`: full view and the dock
   * choice, in a strip that heads the panel. `top bar`: both, in a strip that is the top bar's
   * right part.
   */
  placement: "header" | "panel" | "top bar";
  dockable?: boolean | undefined;
  /** Tools a phone's ⋯ opens directly ("Changes"); the panel's toggle stays in the header. */
  mobileTools?: readonly PanelControlAction[] | undefined;
  renderAction?: ((action: PanelControlAction) => ReactNode) | undefined;
}) {
  const { workspace, actions } = props;
  const phone = usePhone();
  const render = props.renderAction;
  const inStrip = props.placement !== "header";
  const toggle = props.placement !== "panel";
  if (render)
    return (
      <>
        {phone &&
          props.mobileTools?.map((tool) => <Fragment key={tool.label}>{render(tool)}</Fragment>)}
      </>
    );
  return (
    <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
      {inStrip && (
        <IconButton
          icon={workspace.expanded ? ArrowsInSimpleIcon : ArrowsOutSimpleIcon}
          label={workspace.expanded ? "Exit full view" : "Full view"}
          shortcut="fullView"
          onClick={() => withViewTransition(() => actions.setExpanded(!workspace.expanded))}
        />
      )}
      {props.dockable && inStrip && !phone && (
        <>
          <IconButton
            icon={SquareSplitVerticalIcon}
            label="Dock panel at bottom"
            pressed={workspace.dock === "bottom"}
            onClick={() => actions.setDock("bottom")}
          />
          <IconButton
            icon={SquareSplitHorizontalIcon}
            label="Dock panel at side"
            pressed={workspace.dock !== "bottom"}
            onClick={() => actions.setDock("side")}
          />
        </>
      )}
      {toggle && (
        <IconButton
          icon={SquareSplitHorizontalIcon}
          label="Right panel"
          shortcut="rightPanel"
          data-panel-toggle
          pressed={workspace.open}
          onClick={(event) => {
            const focused = event.currentTarget.ownerDocument.activeElement === event.currentTarget;
            actions.toggle();
            if (focused) focusPanelToggle(event.currentTarget.ownerDocument);
          }}
        />
      )}
    </div>
  );
}

/**
 * The toggle moves between the column's part of the top bar and the panel's part above a docked
 * panel as the panel opens and closes: focus follows it to the one now on screen.
 */
function focusPanelToggle(doc: Document) {
  requestAnimationFrame(() => {
    const toggles = doc.querySelectorAll<HTMLElement>("[data-panel-toggle]");
    [...toggles].find((toggle) => !toggle.closest('[inert], [hidden], [role="menu"]'))?.focus();
  });
}
