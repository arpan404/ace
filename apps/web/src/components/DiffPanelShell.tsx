import type { ReactNode } from "react";

import { isElectron } from "~/env";
import { MAC_TITLEBAR_LEFT_INSET_STYLE } from "~/lib/desktopChrome";
import { cn } from "~/lib/utils";
import { useSidebar } from "./ui/sidebar";

import { Skeleton } from "./ui/skeleton";

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

export function DiffPanelHeaderSkeleton() {
  return (
    <>
      <div className="min-w-0 flex-1">
        <Skeleton className="h-8 w-28 rounded-lg" />
      </div>
      <div className="flex shrink-0 gap-2">
        <Skeleton className="size-8 rounded-lg" />
        <Skeleton className="size-8 rounded-lg" />
        <Skeleton className="size-8 rounded-lg" />
      </div>
    </>
  );
}

export function DiffPanelLoadingState(props: { label: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
      <div
        className="flex min-h-0 flex-1 flex-col"
        role="status"
        aria-live="polite"
        aria-label={props.label}
      >
        <div className="flex items-center gap-2.5 border-b border-border/60 pb-3">
          <Skeleton className="h-4 w-28 rounded-full" />
          <Skeleton className="ml-auto h-4 w-16 rounded-full" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 py-4">
          <div className="space-y-2.5">
            <Skeleton className="h-3 w-full rounded-full" />
            <Skeleton className="h-3 w-full rounded-full" />
            <Skeleton className="h-3 w-10/12 rounded-full" />
            <Skeleton className="h-3 w-11/12 rounded-full" />
            <Skeleton className="h-3 w-9/12 rounded-full" />
          </div>
          <span className="sr-only">{props.label}</span>
        </div>
      </div>
    </div>
  );
}
