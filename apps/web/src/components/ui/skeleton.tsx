import { cn } from "@/lib/cn.ts";

/**
 * Placeholder while something loads: quiet grey bars that breathe, shaped like what will
 * replace them, so the layout does not jump when it arrives. Hidden from assistive tech; the
 * surrounding region says it is busy.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      data-slot="skeleton"
      className={cn("fx-skeleton block h-3", className)}
      {...props}
    />
  );
}

/** A few lines of text, the last one shorter. */
function SkeletonText(props: { lines?: number; className?: string }) {
  const lines = props.lines ?? 3;
  return (
    <span aria-hidden className={cn("flex flex-col gap-2", props.className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={index === lines - 1 && lines > 1 ? "w-3/5" : "w-full"}
          style={{ animationDelay: `${index * 90}ms` }}
        />
      ))}
    </span>
  );
}

/**
 * A region that is loading: announces "Loading <label>" once and shows the skeleton.
 * Use in place of a spinner wherever the shape of the content is known.
 */
function LoadingRegion(props: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={`Loading ${props.label}`}
      className={cn("fx-view-in", props.className)}
    >
      {props.children}
    </div>
  );
}

/** Placeholder rows for a list that is loading, shaped like the rows that will replace them. */
function ListSkeleton(props: {
  label: string;
  /**
   * `card`: a Home or Activity card; `row`: a one-line list or settings row; `tile`: a
   * second-sidebar row (`ViewRowBody`) with its icon tile, title and description.
   */
  shape: "card" | "row" | "tile";
  rows?: number;
  className?: string;
}) {
  const rows = props.rows ?? (props.shape === "card" ? 6 : 4);
  return (
    <LoadingRegion label={props.label} className={cn("flex flex-col", props.className)}>
      {Array.from({ length: rows }, (_, index) => {
        const style = { animationDelay: `${index * 70}ms` };
        // Vary the widths a little so the placeholder reads as content, not a grid.
        const width = `${62 + ((index * 23) % 30)}%`;
        if (props.shape === "tile")
          return (
            <span
              key={index}
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 px-[11px] py-[9px]"
            >
              <Skeleton className="mt-px size-[26px] rounded-sm" style={style} />
              <span className="flex flex-col gap-1.5 pt-0.5">
                <Skeleton className="h-3" style={{ ...style, width }} />
                <Skeleton className="h-2.5 w-4/5" style={style} />
              </span>
            </span>
          );
        return props.shape === "card" ? (
          <span key={index} className="flex flex-col gap-[7px] px-[11px] pt-[11px] pb-3">
            <span className="flex justify-between">
              <Skeleton className="h-2.5 w-16" style={style} />
              <Skeleton className="h-2.5 w-6" style={style} />
            </span>
            <Skeleton className="h-3" style={{ ...style, width }} />
            <Skeleton className="h-2.5 w-28" style={style} />
          </span>
        ) : (
          <span key={index} className="flex items-center gap-3 border-t py-3.5 first:border-t-0">
            <Skeleton className="h-3" style={{ ...style, width }} />
            <Skeleton className="ml-auto h-3 w-14 shrink-0" style={style} />
          </span>
        );
      })}
    </LoadingRegion>
  );
}

export { Skeleton, SkeletonText, LoadingRegion, ListSkeleton };
