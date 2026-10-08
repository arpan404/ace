import {
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  SquareSplitHorizontalIcon,
} from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { withViewTransition } from "@/lib/motion.ts";
import type { ScopeWorkspace, WorkspaceActions } from "@/lib/workspace/index.ts";

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
}) {
  const { workspace, actions } = props;
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
      <IconButton
        icon={SquareSplitHorizontalIcon}
        label="Right panel"
        shortcut="rightPanel"
        data-panel-toggle
        pressed={workspace.open}
        onClick={() => actions.toggle()}
      />
    </div>
  );
}
