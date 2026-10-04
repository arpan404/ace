import { ArrowsOutSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { withViewTransition } from "@/lib/motion.ts";
import { countButton, CountMark } from "./count-mark.tsx";
import {
  shownTab,
  type ScopeWorkspace,
  type WorkspaceActions,
  type WorkspaceDefinition,
} from "@/lib/workspace/index.ts";

export interface OpenTabsProps {
  workspace: ScopeWorkspace;
  definition: WorkspaceDefinition;
  actions: WorkspaceActions;
  /** Open at once (it loaded because someone clicked or is still hovering). */
  defaultOpen?: boolean;
}

/** "3": the side panel's open tabs; hover or click lists them, each with a full-view action. */
export function OpenTabs(props: OpenTabsProps) {
  const { workspace, definition, actions } = props;
  const tabs = workspace.right.tabs;
  const shown = shownTab(workspace.right)?.key;
  const label = `${tabs.length} open ${tabs.length === 1 ? "tab" : "tabs"}`;
  const hover = useHoverOpen(props.defaultOpen ?? false);
  return (
    <Popover open={hover.open} onOpenChange={hover.setOpen}>
      <PopoverTrigger
        aria-label={label}
        className={countButton}
        onPointerEnter={hover.enter}
        onPointerLeave={hover.leave}
      >
        <CountMark count={tabs.length} />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[280px] p-1.5"
        onPointerEnter={hover.enter}
        onPointerLeave={hover.leave}
      >
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

/**
 * Opens a quarter second after the pointer rests on the trigger and closes shortly after it
 * leaves both trigger and list; a click or Enter toggles it at once.
 */
function useHoverOpen(initial: boolean) {
  const [open, setOpen] = useState(initial);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const later = (next: boolean, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), ms);
  };
  return {
    open,
    setOpen: (next: boolean) => {
      clearTimeout(timer.current);
      setOpen(next);
    },
    enter: (event: React.PointerEvent) => {
      if (event.pointerType === "mouse") later(true, open ? 0 : 250);
    },
    leave: (event: React.PointerEvent) => {
      if (event.pointerType === "mouse") later(false, 200);
    },
  };
}
