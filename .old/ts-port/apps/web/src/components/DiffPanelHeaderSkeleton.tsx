import { Skeleton } from "./ui/skeleton";

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
