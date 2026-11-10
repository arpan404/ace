import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn.ts";

/*
 * The details card's pieces: 34px rows, one 16px muted glyph in one column, 13px words, a
 * trailing caret on one right edge, transparent until hovered. One hairline between sections.
 */

/** A row's leading glyph colour: muted, so the words lead. */
export const rowIcon = "shrink-0 text-muted-foreground";

const row =
  "flex h-[34px] w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-ui text-foreground";

/** A row that does something: opens a menu, a tab or a pull request. */
export function RowButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        row,
        "focus-ring-inset transition-colors duration-(--motion-fast) hover:bg-accent aria-expanded:bg-accent disabled:text-muted-foreground disabled:hover:bg-transparent",
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

/**
 * A row with its own action and a menu behind its caret, as one row: no divider between them,
 * and the caret on the same right edge as every other row's. `children` are the row's buttons.
 */
export function RowSplit(props: { children: ReactNode; className?: string | undefined }) {
  return (
    <div
      className={cn(
        "flex h-[34px] min-w-0 items-center rounded-md text-ui text-foreground transition-colors duration-(--motion-fast) hover:bg-accent has-aria-expanded:bg-accent",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}

/** The leading part of a split row: its glyph and words, from the row's left edge. */
export const splitMain =
  "focus-ring-inset flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-l-md pl-2.5 pr-1 text-left";

/** The caret part of a split row, ending at the row's right padding like every caret. */
export const splitCaret =
  "focus-ring-inset grid h-full shrink-0 place-items-center rounded-r-md pr-2.5 pl-1.5 text-muted-foreground hover:text-foreground";

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
export function RowCaret(props: { to?: "menu" | "elsewhere"; className?: string | undefined }) {
  const Glyph = props.to === "elsewhere" ? CaretRightIcon : CaretDownIcon;
  return (
    <Glyph
      aria-hidden
      size={14}
      className={cn(rowIcon, "transition-transform duration-(--motion-fast)", props.className)}
    />
  );
}

/** A small text action at a row's end: Merge, Stop. */
export function RowAction({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "relative focus-ring touch-hit -mr-1 ml-auto h-6 shrink-0 rounded-sm px-2 text-xs font-medium text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

/**
 * What stops the checkout, as a row that grows: the failed glyph and its words, why on the line
 * beneath, then its ways out as text buttons. Never fixed at one row's height, so a long reason
 * or a second action wraps inside it rather than over the row below.
 */
export function RowProblem(props: {
  label: string;
  detail?: string | undefined;
  glyph: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={props.detail ? `${props.label}. ${props.detail}` : props.label}
      className="flex min-w-0 flex-col gap-0.5 px-2.5 py-2 text-ui text-foreground"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {props.glyph}
        <span className="min-w-0 flex-1">{props.label}</span>
      </div>
      {props.detail && (
        <p className="pl-[26px] text-xs text-pretty text-muted-foreground">{props.detail}</p>
      )}
      {props.children && (
        <div className="-ml-2 flex flex-wrap items-center gap-1 pt-0.5 pl-[26px]">
          {props.children}
        </div>
      )}
    </div>
  );
}

/**
 * One of the card's sections (Workspace, Branch, Agents). A hairline between sections divides
 * them; a quiet caption names each section where the rows alone don't say what they are.
 * `label` names it for assistive tech; `title` shows that caption.
 */
export function Section(props: { label: string; title?: string; children: ReactNode }) {
  return (
    <section aria-label={props.label} className="px-1.5 py-1.5 [&+&]:border-t [&+&]:border-border">
      {props.title && (
        <h3 className="flex h-6 items-center px-2.5 text-xs text-muted-foreground">
          {props.title}
        </h3>
      )}
      {props.children}
    </section>
  );
}
