import type { ComponentProps } from "react";
import { cn } from "@/lib/cn.ts";

/**
 * A row's action as a word, not a box: "Fix with agent · Reply · Show in code". `strong` is the
 * row's lead action, brighter; the rest are muted until hovered.
 */
export function TextAction({
  strong,
  className,
  ...props
}: ComponentProps<"button"> & { strong?: boolean | undefined }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "rounded-xs text-xs transition-colors duration-(--motion-fast) focus-ring touch-hit hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
        strong ? "font-medium text-foreground/90" : "text-muted-foreground",
        className,
      )}
    />
  );
}
