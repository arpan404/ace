import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { useGroupOpen, type WorkGroup } from "./work-card-folds.ts";

/*
 * The Work card's pieces at T3's toolbar scale: 32px rows, a 16px muted glyph, 13px words,
 * transparent until hovered. No rules between groups: a quiet fold title starts each one.
 */

/** A row's leading glyph colour: muted, so the words lead. */
export const rowIcon = "shrink-0 text-muted-foreground";

const row =
  "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-ui text-foreground";

/** A row that does something: opens a menu, a tab or a pull request. */
export function RowButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        row,
        "focus-ring-inset transition-colors duration-(--dur-1) hover:bg-accent aria-expanded:bg-accent disabled:text-muted-foreground disabled:hover:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

/** A row that states something and may end in its own small action (Merge, Stop). */
export function RowStatic(props: {
  children: ReactNode;
  className?: string | undefined;
  label?: string | undefined;
}) {
  return (
    <div role="group" aria-label={props.label} className={cn(row, props.className)}>
      {props.children}
    </div>
  );
}

/** A row's words, cut with an ellipsis. */
export function RowLabel({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("min-w-0 flex-1 truncate", className)} {...props} />;
}

/** Muted words after a row's label: "open · checks passed". */
export function RowSub({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn("min-w-0 shrink truncate text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

/** The trailing caret: ⌄ opens a menu, › opens somewhere else. */
export function RowCaret(props: { to?: "menu" | "elsewhere" }) {
  const Glyph = props.to === "elsewhere" ? CaretRightIcon : CaretDownIcon;
  return <Glyph aria-hidden size={14} className={rowIcon} />;
}

/** A small text action at a row's end: Merge, Stop. */
export function RowAction({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "focus-ring touch-hit -mr-1 ml-auto h-6 shrink-0 rounded-sm px-2 text-xs font-medium text-muted-foreground transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A folding group: its title folds it, the fold is remembered on this device, and `action`
 * (Environment's settings gear) sits at the title's end.
 */
export function Group(props: {
  id: WorkGroup;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, toggle] = useGroupOpen(props.id);
  const body = `work-${props.id}`;
  return (
    <section aria-label={props.title} className="px-1.5 py-1 first:pt-1.5 last:pb-1.5">
      <div className="flex h-[26px] items-center pr-1 pl-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={body}
          onClick={toggle}
          className="focus-ring -ml-1 inline-flex h-[22px] items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground"
        >
          <CaretDownIcon
            aria-hidden
            size={12}
            className={cn(
              "transition-transform duration-(--dur-2) ease-spring",
              !open && "-rotate-90",
            )}
          />
          {props.title}
        </button>
        {props.action && <span className="ml-auto flex">{props.action}</span>}
      </div>
      {open && (
        <div id={body} className="fx-fade-in">
          {props.children}
        </div>
      )}
    </section>
  );
}
