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
      <div className="relative min-w-0 flex-1">
        <Skeleton className="absolute left-0 top-1/2 size-6 -translate-y-1/2 rounded-lg border border-border" />
        <Skeleton className="absolute right-0 top-1/2 size-6 -translate-y-1/2 rounded-lg border border-border" />
        <div className="flex gap-1.5 overflow-hidden px-8 py-0.5">
          <Skeleton className="h-6 w-16 shrink-0 rounded-lg" />
          <Skeleton className="h-6 w-24 shrink-0 rounded-lg" />
          <Skeleton className="h-6 w-24 shrink-0 rounded-lg max-sm:hidden" />
        </div>
      </div>
      <div className="flex shrink-0 gap-1">
        <Skeleton className="size-7 rounded-lg" />
        <Skeleton className="size-7 rounded-lg" />
      </div>
    </>
  );
}

export function DiffPanelLoadingState(props: { label: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-2.5">
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card"
        role="status"
        aria-live="polite"
        aria-label={props.label}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5">
          <Skeleton className="h-4 w-32 rounded-full" />
          <Skeleton className="ml-auto h-4 w-20 rounded-full" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-3.5 py-4">
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
