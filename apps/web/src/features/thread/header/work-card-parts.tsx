import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn.ts";

/** A row's leading glyph colour: muted, so the words lead. */
export const rowIcon = "shrink-0 text-muted-foreground";

const row =
  "flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-xs text-foreground";

/** A row that does something: opens a tab, runs a script, opens a pull request. */
export function RowButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        row,
        "focus-ring-inset transition-colors duration-(--dur-1) hover:bg-accent disabled:text-muted-foreground disabled:hover:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

/** A row that only says something ("No pull request yet"). */
export function RowNote(props: { children: ReactNode; className?: string | undefined }) {
  return <p className={cn(row, "text-subtle-foreground", props.className)}>{props.children}</p>;
}

/** A cut line ends with an ellipsis. */
export function TruncatedText({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("min-w-0 flex-1 truncate", className)} {...props} />;
}
