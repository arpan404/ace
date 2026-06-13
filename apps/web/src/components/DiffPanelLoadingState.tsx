import { Skeleton } from "./ui/skeleton";

export function DiffPanelLoadingState(props: { label: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
      <output className="flex min-h-0 flex-1 flex-col" aria-live="polite" aria-label={props.label}>
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
      </output>
    </div>
  );
}
