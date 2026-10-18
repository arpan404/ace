import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn.ts";

/*
 * The one row anatomy every transcript row shares (a step group, a thought, a background task, an
 * error, a refusal, a system event, "Worked for", a subagent):
 *
 *   [lead 20] · title · optional muted subtitle (second line) · … · meta
 *
 * 32px tall (44px under a coarse pointer), flush with the reading column: its hover fill bleeds
 * 8px past the column on both sides, so the lead's icon lines up with the prose above it. No
 * trailing caret: a row that opens is a button with `aria-expanded`, and the open state shows as
 * the `--active` wash, not an arrow.
 */

const rowBox =
  "flex min-h-8 min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-ui pointer-coarse:min-h-11";

const pressable =
  "transition-colors duration-(--motion-fast) hover:bg-hover aria-expanded:bg-active focus-ring-inset";

/** A row's box at rest: lay a row's parts out in it, on any element (a link, a button, a div). */
export const rowClass = cn("-mx-2 w-[calc(100%+--spacing(4))]", rowBox);

/** A row the reader presses: hover and open washes and an inset focus ring. */
export const pressableRowClass = cn(rowClass, pressable);

/** A pressable row inside a card (4px padding, concentric corners): no bleed past its edge. */
export const cardRowClass = cn("w-full", rowBox, pressable);

/** How loud the title reads: an agent, error or question is `strong`; a step sentence is `step`. */
export type RowTone = "strong" | "step";

const titleTone: Record<RowTone, string> = {
  strong: "font-medium text-foreground",
  step: "text-muted-foreground",
};

/** Where a row's details open: indented to the title, past the lead and the gap. */
export const rowDetailIndent = "pl-7";

/** The row's parts, for a container the caller owns (a router link, say). */
export function RowParts(props: {
  /** A 16px icon in the subtle tier, or a 20–24px avatar; none for a plain line ("Worked for"). */
  lead?: ReactNode;
  /** What the lead shows, for tests and assistive tech hooks: `data-lead="thought"`. */
  leadKind?: string | undefined;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  tone?: RowTone | undefined;
  /** The title's own classes, such as a shimmer while the step is in flight. */
  titleClassName?: string | undefined;
}) {
  return (
    <>
      {props.lead !== undefined && (
        <span
          data-lead={props.leadKind}
          className="flex min-w-5 shrink-0 items-center justify-center text-subtle-foreground"
        >
          {props.lead}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn("min-w-0 truncate", titleTone[props.tone ?? "step"], props.titleClassName)}
        >
          {props.title}
        </span>
        {props.subtitle !== undefined && props.subtitle !== null && props.subtitle !== false && (
          // A subtitle component with nothing to say leaves no empty second line.
          <span className="min-w-0 truncate text-xs text-muted-foreground empty:hidden">
            {props.subtitle}
          </span>
        )}
      </span>
      {props.meta !== undefined && props.meta !== null && props.meta !== false && (
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-xs text-subtle-foreground tabular-nums">
          {props.meta}
        </span>
      )}
    </>
  );
}

type PartsProps = ComponentProps<typeof RowParts>;

/** A row that opens its details in place: a button with `aria-expanded`, no caret. */
export function TranscriptRow(
  props: PartsProps & {
    expanded: boolean;
    onToggle(): void;
    /** The id of the panel the row opens. */
    controls?: string | undefined;
    label?: string | undefined;
    /** A tooltip, such as the full summary of a group showing its step in flight. */
    hint?: string | undefined;
    /** A work log's group or thought: marked so a log can be opened step by step. */
    stepGroup?: boolean | undefined;
    className?: string | undefined;
  },
) {
  const { expanded, onToggle, controls, label, hint, stepGroup, className, ...parts } = props;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={controls}
      aria-label={label}
      title={hint}
      data-transcript-row=""
      data-step-group={stepGroup ? "" : undefined}
      onClick={onToggle}
      className={cn(pressableRowClass, className)}
    >
      <RowParts {...parts} />
    </button>
  );
}

/** A row with nothing to open: the same box and parts, as plain content. */
export function StaticRow(
  props: PartsProps & {
    role?: string | undefined;
    stepGroup?: boolean | undefined;
    className?: string | undefined;
  },
) {
  const { role, stepGroup, className, ...parts } = props;
  return (
    <div
      role={role}
      data-transcript-row=""
      data-step-group={stepGroup ? "" : undefined}
      className={cn(rowClass, className)}
    >
      <RowParts {...parts} />
    </div>
  );
}
