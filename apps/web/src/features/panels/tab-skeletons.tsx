import { LoadingRegion, Skeleton, SkeletonText } from "@/components/ui/skeleton.tsx";

/*
 * What a tool's tab looks like while its code loads: its toolbar and the shape of its content,
 * so the tab doesn't jump from a centred spinner to a full view. Loaded with the kinds, so keep
 * these to a few bars.
 */

/** The 40px strip every tool's view starts with. */
function Toolbar() {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 px-3 shadow-[inset_0_-1px_0_var(--border)]">
      <Skeleton className="w-24" />
      <Skeleton className="ml-auto w-12" />
    </div>
  );
}

/** Files: the toolbar, then the tree's column of names beside an empty file. */
export function FilesSkeleton() {
  return (
    <LoadingRegion label="Files" className="flex h-full flex-col">
      <Toolbar />
      <div className="w-[240px] max-w-full p-3">
        <SkeletonText lines={6} />
      </div>
    </LoadingRegion>
  );
}

/** Changes: the toolbar, then three file headers. */
export function ChangesSkeleton() {
  return (
    <LoadingRegion label="Changes" className="flex h-full flex-col">
      <Toolbar />
      <div className="flex flex-col gap-3 p-3">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-8 w-full rounded-md" />
        ))}
      </div>
    </LoadingRegion>
  );
}

/** Terminals and Logs: the toolbar, then a few lines of output. */
export function OutputSkeleton() {
  return (
    <LoadingRegion label="output" className="flex h-full flex-col">
      <Toolbar />
      <SkeletonText lines={4} className="max-w-[480px] p-3" />
    </LoadingRegion>
  );
}
