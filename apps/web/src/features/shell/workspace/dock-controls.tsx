import {
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  SquareHalfBottomIcon,
  SquareSplitHorizontalIcon,
} from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { withViewTransition } from "@/lib/motion.ts";
import {
  shownTab,
  type ScopeWorkspace,
  type WorkspaceActions,
  type WorkspaceDefinition,
} from "@/lib/workspace/index.ts";

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
  const count = workspace.right.tabs.length;
  return (
    <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
      {props.bottom && (
        <IconButton
          icon={SquareHalfBottomIcon}
          label="Bottom panel"
          shortcut="bottomPanel"
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
        <OpenTabs workspace={workspace} definition={props.definition} actions={actions} />
      )}
      <IconButton
        icon={SquareSplitHorizontalIcon}
        label="Right panel"
        shortcut="rightPanel"
        pressed={workspace.right.open}
        onClick={() => actions.toggle("right")}
      />
    </div>
  );
}

/** "3": the side panel's open tabs; hover or click lists them, each with a full-view action. */
function OpenTabs(props: {
  workspace: ScopeWorkspace;
  definition: WorkspaceDefinition;
  actions: WorkspaceActions;
}) {
  const { workspace, definition, actions } = props;
  const tabs = workspace.right.tabs;
  const shown = shownTab(workspace.right)?.key;
  const label = `${tabs.length} open ${tabs.length === 1 ? "tab" : "tabs"}`;
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={250}
        aria-label={label}
        className="inline-flex h-[30px] min-w-[30px] items-center justify-center rounded-md px-1.5 text-muted-foreground outline-none transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)] aria-expanded:bg-accent aria-expanded:text-foreground"
      >
        <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] px-1 text-[11px] leading-none font-semibold tabular-nums shadow-[inset_0_0_0_1.5px_currentColor]">
          {tabs.length}
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[280px] p-1.5">
        <p className="px-2 pt-1 pb-1.5 text-[11px] font-medium tracking-[0.02em] text-subtle-foreground">
          Open tabs
        </p>
        <ul aria-label="Open tabs" className="flex flex-col">
          {tabs.map((tab) => {
            const kind = definition.kind(tab.kind);
            const title = definition.title(tab);
            return (
              <li key={tab.key} className="group/row flex h-[30px] items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => actions.activate(tab.key)}
                  className={cn(
                    "flex h-full min-w-0 flex-1 items-center gap-[9px] rounded-md px-2 text-left text-ui outline-none hover:bg-accent focus-visible:bg-accent",
                    tab.key === shown ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {kind && <Icon icon={kind.icon} size={14} />}
                  <span className="min-w-0 truncate">{title}</span>
                </button>
                <Tip label={`Open ${title} in full view`} shortcut="fullView">
                  <button
                    type="button"
                    aria-label={`Open ${title} in full view`}
                    onClick={() =>
                      withViewTransition(() => {
                        actions.activate(tab.key);
                        actions.setExpanded(true);
                      })
                    }
                    className="grid size-[26px] shrink-0 place-items-center rounded-md text-subtle-foreground opacity-0 outline-none group-hover/row:opacity-100 hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:opacity-100"
                  >
                    <ArrowsOutSimpleIcon aria-hidden size={14} />
                  </button>
                </Tip>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
