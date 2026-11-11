import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";

/** The Summary's box: the reading surface with a hairline edge, holding one whole thing. */
export const prBox = "rounded-lg border border-border bg-background";

/** A box's foot: a hairline above, on the box's quiet wash. */
export const prBoxFoot =
  "flex min-h-11 items-center gap-2.5 rounded-b-lg border-t border-border bg-surface-1 px-4 py-2.5";

/** A box's head: what it holds and who wrote it, its actions at the right, a hairline below. */
export function PrBoxHead(props: { children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex min-h-10 items-center gap-2 rounded-t-lg border-b border-border bg-surface-1 py-1.5 pr-2 pl-3.5 text-ui text-muted-foreground",
        props.className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">{props.children}</div>
      {props.actions && <div className="flex shrink-0 items-center gap-0.5">{props.actions}</div>}
    </div>
  );
}
