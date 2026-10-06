import {
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  SquareHalfBottomIcon,
  SquareSplitHorizontalIcon,
} from "@phosphor-icons/react";
import { useState, type ComponentType } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { withViewTransition } from "@/lib/motion.ts";
import type {
  ScopeWorkspace,
  WorkspaceActions,
  WorkspaceDefinition,
} from "@/lib/workspace/index.ts";
import { countButton, countedTabs, CountMark, openTabsLabel } from "./count-mark.tsx";
import type { OpenTabsProps } from "./open-tabs.tsx";

/**
 * The docks' toggles, always at the far right of the window's top row: the bottom panel, full
 * view (while the side panel shows) and the side panel, with the number of its open tabs.
 * Hovering the number lists them. One set of labels, shortcuts and pressed states everywhere.
 */
export function DockControls(props: {
  scope: string;
  workspace: ScopeWorkspace;
  definition: WorkspaceDefinition;
  actions: WorkspaceActions;
  /** In the side panel's own strip (it is showing) or in the header (it is not). */
  placement: "header" | "panel";
  /** The bottom dock exists on this screen. */
  bottom: boolean;
}) {
  const { workspace, actions } = props;
  const count = countedTabs(workspace, props.definition).length;
  return (
    <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
      {props.bottom && (
        <IconButton
          icon={SquareHalfBottomIcon}
          label="Bottom panel"
          shortcut="bottomPanel"
          data-dock-toggle="bottom"
          pressed={workspace.bottom.open}
          onClick={() => actions.toggle("bottom")}
        />
      )}
      {props.placement === "panel" && (
        <IconButton
          icon={workspace.expanded ? ArrowsInSimpleIcon : ArrowsOutSimpleIcon}
          label={workspace.expanded ? "Exit full view" : "Full view"}
          shortcut="fullView"
          onClick={() => withViewTransition(() => actions.setExpanded(!workspace.expanded))}
        />
      )}
      {props.placement === "header" && count > 0 && (
        <OpenTabsCount
          scope={props.scope}
          workspace={workspace}
          definition={props.definition}
          actions={actions}
        />
      )}
      <IconButton
        icon={SquareSplitHorizontalIcon}
        label="Right panel"
        shortcut="rightPanel"
        data-dock-toggle="right"
        pressed={workspace.right.open}
        onClick={() => actions.toggle("right")}
      />
    </div>
  );
}

/** The list's code: warmed while idle after the screen paints, or fetched on first use. */
let LoadedOpenTabs: ComponentType<OpenTabsProps> | undefined;
export const loadOpenTabs = () =>
  import("./open-tabs.tsx").then((module) => {
    LoadedOpenTabs = module.OpenTabs;
  });

/**
 * "3": the side panel's open tabs; hover or click lists them. Until the list's code has loaded
 * this is a plain button that fetches it and then opens.
 */
function OpenTabsCount(props: Omit<OpenTabsProps, "defaultOpen">) {
  // Reads module state that changes once, when the code arrives.
  "use no memo";
  const [wanted, setWanted] = useState<"hover" | "click">();
  const [, setLoaded] = useState(false);
  const Loaded = LoadedOpenTabs;
  if (Loaded) return <Loaded {...props} defaultOpen={wanted !== undefined} />;
  const count = countedTabs(props.workspace, props.definition).length;
  const want = (why: "hover" | "click") => {
    setWanted(why);
    void Promise.all([loadOpenTabs(), props.definition.load()]).then(
      () => setLoaded(true),
      () => setWanted(undefined),
    );
  };
  return (
    <button
      type="button"
      aria-label={openTabsLabel(props.workspace, props.definition)}
      className={countButton}
      onPointerEnter={() => want("hover")}
      onPointerLeave={() => setWanted((current) => (current === "hover" ? undefined : current))}
      onClick={() => want("click")}
    >
      <CountMark count={count} />
    </button>
  );
}
