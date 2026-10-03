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

export { Skeleton, SkeletonText, LoadingRegion };
