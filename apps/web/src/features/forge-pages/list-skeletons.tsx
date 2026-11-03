import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";

/** Title widths that vary like real rows do, never a grid. */
const titleWidths = ["58%", "72%", "46%", "64%", "38%", "69%", "52%", "60%"];
const metaWidths = [176, 132, 208, 150, 188, 120, 164, 144];

/**
 * Rows inside a list box while it loads, built like its rows: the state mark, the title, and
 * the line under it, with the same padding and hairlines, so nothing moves when rows arrive.
 */
export function RowsSkeleton(props: { label?: string; rows?: number }) {
  const rows = props.rows ?? 8;
  return (
    <LoadingRegion label={props.label ?? "rows"}>
      <ul aria-hidden>
        {Array.from({ length: rows }, (_, index) => {
          const style = { animationDelay: `${index * 60}ms` };
          return (
            <li key={index} className="flex gap-2 border-b border-border px-4 py-2 last:border-b-0">
              <Skeleton className="mt-1 size-4 shrink-0 rounded-full" style={style} />
              <span className="flex min-w-0 flex-1 flex-col gap-1.5 py-1">
                <Skeleton
                  className="h-3.5"
                  style={{ ...style, width: titleWidths[index % titleWidths.length] }}
                />
                <Skeleton
                  className="h-3"
                  style={{ ...style, width: metaWidths[index % metaWidths.length] }}
                />
              </span>
            </li>
          );
        })}
      </ul>
    </LoadingRegion>
  );
}
