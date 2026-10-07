import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn.ts";

/*
 * The work card's few shapes: a muted section heading, a 32px row with a leading 16px icon, and
 * the hairline between sections. 13px text throughout, as in the rest of the app's menus.
 */

/** A row's leading glyph colour: muted, so the words lead. */
export const rowIcon = "shrink-0 text-muted-foreground";

const row =
  "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-ui text-foreground";

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
export function RowNote(props: { children: ReactNode; className?: string }) {
  return <p className={cn(row, "text-subtle-foreground", props.className)}>{props.children}</p>;
}

/** A section's muted heading, with its own controls (+) at the end. */
export function SectionHead(props: { id: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex h-8 items-center gap-1 pr-1 pl-2.5">
      <h3 id={props.id} className="min-w-0 flex-1 truncate text-ui text-subtle-foreground">
        {props.title}
      </h3>
      {props.children}
    </div>
  );
}

export function Rule() {
  return <hr aria-hidden className="mx-2.5 my-1.5 border-t border-border" />;
}

/** The fade at a cut line's end (inline: a one-off value, ADR 0056 CSS budget). */
const fade = { maskImage: "linear-gradient(to right, black calc(100% - 24px), transparent)" };

/** Text that fades out where it is cut, rather than ending in an ellipsis. */
export function Fade(props: { children: ReactNode; className?: string }) {
  return (
    <span
      style={fade}
      className={cn("min-w-0 flex-1 overflow-hidden whitespace-nowrap", props.className)}
    >
      {props.children}
    </span>
  );
}
