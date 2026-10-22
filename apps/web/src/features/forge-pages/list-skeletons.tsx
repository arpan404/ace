import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { cn } from "@/lib/cn.ts";
import { rowClass } from "./row-parts.tsx";

/** Title, author and branch widths that vary like real rows do, never a grid. */
const titleWidths = ["58%", "72%", "46%", "64%", "38%", "69%", "52%", "60%"];
const branchWidths = [176, 132, 208, 150, 188, 120, 164, 144];

/**
 * Pull request or issue rows while a list loads, built like `PrRow` and `IssueRow`: the state
 * glyph, number and title on the first line with the size (PRs) or people at the right; the
 * author's avatar and name, the branches (PRs) and the age on the second. Same row box and
 * gutter, so nothing moves when the rows arrive.
 */
export function RowsSkeleton(props: { kind: "pulls" | "issues"; rows?: number }) {
  const rows = props.rows ?? 8;
  return (
    <LoadingRegion label={props.kind === "pulls" ? "pull requests" : "issues"}>
      <ul aria-hidden className="pt-3">
        {Array.from({ length: rows }, (_, index) => {
          const style = { animationDelay: `${index * 60}ms` };
          return (
            <li key={index} className="border-b border-border last:border-b-0">
              <div className={cn(rowClass, "hover:bg-transparent")}>
                <span className="pt-0.5">
                  <Skeleton className="size-4 rounded-full" style={style} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex h-5 min-w-0 items-center gap-2">
                    <Skeleton className="h-3 w-9 shrink-0" style={style} />
                    <Skeleton
                      className="h-3.5"
                      style={{ ...style, width: titleWidths[index % titleWidths.length] }}
                    />
                    <span className="ml-auto flex shrink-0 items-center gap-2.5 pl-2">
                      {props.kind === "pulls" ? (
                        <Skeleton className="h-3 w-16" style={style} />
                      ) : (
                        <Skeleton className="size-5 rounded-full" style={style} />
                      )}
                    </span>
                  </span>
                  <span className="flex min-h-5 min-w-0 items-center gap-1.5">
                    <Skeleton className="size-4 shrink-0 rounded-full" style={style} />
                    <Skeleton className="h-3 w-16 shrink-0" style={style} />
                    {props.kind === "pulls" && (
                      <Skeleton
                        className="h-3 shrink"
                        style={{ ...style, width: branchWidths[index % branchWidths.length] }}
                      />
                    )}
                    <Skeleton className="ml-auto h-3 w-6 shrink-0" style={style} />
                  </span>
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </LoadingRegion>
  );
}
