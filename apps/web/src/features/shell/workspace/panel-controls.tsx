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
 * The side panel's controls, always at the far right of the window's top row: full view (while
 * the panel shows) and the panel's toggle. One set of labels, shortcuts and pressed states
 * whether they sit in the header or in the panel's own strip.
 */
export function PanelControls(props: {
  workspace: ScopeWorkspace;
  actions: WorkspaceActions;
  /** In the panel's own strip (it is showing) or in the header (it is not). */
  placement: "header" | "panel";
  dockable?: boolean | undefined;
  mobileAction: { label: string; onClick(): void };
  /** Tools a phone's ⋯ opens directly, after the panel action. */
  mobileTools?: readonly PanelControlAction[] | undefined;
  renderAction?: ((action: PanelControlAction) => ReactNode) | undefined;
}) {
  const { workspace, actions } = props;
  const phone = usePhone();
  const render = props.renderAction;
  if (render)
    return (
      <>
        {render({
          icon: SquareSplitHorizontalIcon,
          label: props.mobileAction.label,
          shortcut: "rightPanel",
          onClick: props.mobileAction.onClick,
        })}
        {phone &&
          props.mobileTools?.map((tool) => <Fragment key={tool.label}>{render(tool)}</Fragment>)}
      </>
    );
  return (
    <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
      {props.placement === "panel" && (
        <IconButton
          icon={workspace.expanded ? ArrowsInSimpleIcon : ArrowsOutSimpleIcon}
          label={workspace.expanded ? "Exit full view" : "Full view"}
          shortcut="fullView"
          onClick={() => withViewTransition(() => actions.setExpanded(!workspace.expanded))}
        />
      )}
      {props.dockable && props.placement === "panel" && !phone && (
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
      {(!props.dockable || props.placement === "header" || phone) && (
        <IconButton
          icon={SquareSplitHorizontalIcon}
          label={phone ? props.mobileAction.label : "Right panel"}
          shortcut="rightPanel"
          data-panel-toggle
          pressed={workspace.open}
          onClick={() => (phone ? props.mobileAction.onClick() : actions.toggle())}
        />
      )}
    </div>
  );
}
