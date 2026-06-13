import type { ReactNode } from "react";

import { isElectron } from "~/env";
import { MAC_TITLEBAR_LEFT_INSET_STYLE } from "~/lib/desktopChrome";
import { cn } from "~/lib/utils";
import { useSidebar } from "./ui/sidebar";

export type DiffPanelMode = "inline" | "sheet" | "sidebar";

function getDiffPanelHeaderRowClassName(mode: DiffPanelMode) {
  const shouldUseDragRegion = isElectron && mode !== "sheet";
  return cn(
    "flex items-center justify-between gap-2.5 px-4",
    shouldUseDragRegion ? "drag-region h-[52px] border-b border-border/40" : "h-12",
  );
}

export function DiffPanelShell(props: {
  mode: DiffPanelMode;
  header: ReactNode;
  children: ReactNode;
}) {
  const { state: sidebarState } = useSidebar();
  const shouldUseDragRegion = isElectron && props.mode !== "sheet";
  const shouldApplyMacTitlebarInset = shouldUseDragRegion && sidebarState === "collapsed";

  return (
    <div
      className={cn(
        "flex h-full min-w-0 flex-col bg-background",
        props.mode === "inline"
          ? "w-[42vw] min-w-[360px] max-w-[560px] shrink-0 border-l border-border/40"
          : "w-full",
      )}
    >
      {shouldUseDragRegion ? (
        <div
          className={getDiffPanelHeaderRowClassName(props.mode)}
          style={shouldApplyMacTitlebarInset ? MAC_TITLEBAR_LEFT_INSET_STYLE : undefined}
        >
          {props.header}
        </div>
      ) : (
        <div className="border-b border-border/40">
          <div
            className={getDiffPanelHeaderRowClassName(props.mode)}
            style={shouldApplyMacTitlebarInset ? MAC_TITLEBAR_LEFT_INSET_STYLE : undefined}
          >
            {props.header}
          </div>
        </div>
      )}
      {props.children}
    </div>
  );
}
