import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { Screen } from "@/features/shell/index.ts";
import {
  composerEnvironmentRow,
  composerEnvironmentSurface,
  composerSurface,
  readingColumn,
} from "@/features/thread/index.ts";
import { cn } from "@/lib/cn.ts";

/**
 * New thread before the projects are known: the page as it will be, the strip's controls and
 * the composer's footer as skeleton pills, so nothing moves when they arrive.
 */
export function NewThreadSkeleton() {
  return (
    <Screen title="New thread">
      <LoadingRegion
        label="New thread"
        className="flex h-full min-h-0 flex-col pt-6 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <div className={cn(readingColumn, "mt-auto")}>
          <div className={composerEnvironmentSurface}>
            <div className={cn(composerEnvironmentRow, "gap-3 px-4")}>
              <Skeleton className="w-24" />
              <Skeleton className="w-16" />
              <Skeleton className="w-20" />
            </div>
          </div>
          <div className={cn(composerSurface, "relative z-10 flex flex-col rounded-xl")}>
            <p className="px-4 pt-3.5 pb-1.5 text-ui leading-5 text-subtle-foreground">
              Describe a task
            </p>
            <div className="h-5" />
            <div className="flex h-11 items-center gap-2 px-2 pb-1.5">
              <Skeleton className="size-8 rounded-full" />
              <Skeleton className="h-8 w-24 rounded-full" />
              <Skeleton className="ml-auto h-8 w-28 rounded-full" />
              <Skeleton className="size-8 rounded-full" />
            </div>
          </div>
        </div>
      </LoadingRegion>
    </Screen>
  );
}
