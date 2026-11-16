import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";

/** A layer over the preview's box that fades in for one state. */
const layer =
  "pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-(--motion-base) ease-(--ease-out) motion-reduce:transition-none";
/** A ring 2px outside the preview's edge, settling in from just inside it. */
const ring = cn(
  layer,
  "-inset-1 rounded-[calc(var(--radius-lg)+4px)] border-2 scale-[0.97] transition-[opacity,scale] ease-spring",
);

/**
 * One choice in the mode or look picker: a radio that is its preview, its name beneath. No card
 * around it: the preview is the thing chosen. Each state has its own layer, so one never wipes
 * out another: hovering lifts the preview and fades a soft shadow in under it; the chosen one
 * draws the accent ring a 2px gap outside its edge, which fades and settles in when picked and
 * stays through hover; keyboard focus draws its own ring the same way. Only transform and
 * opacity move. The name is the accessible label, so the preview stays decoration. A disabled
 * choice is dimmed and skipped by the arrow keys; `after` (what it needs fixed) sits under it,
 * outside the radio.
 */
export function PickerCard(props: {
  label: string;
  description?: string | undefined;
  checked: boolean;
  disabled?: boolean | undefined;
  onChoose: () => void;
  preview: ReactNode;
  /** Short facts beside the name ("Scene", "Dark only"). */
  tags?: readonly string[] | undefined;
  /** The name's font, e.g. the theme's own interface face. */
  labelStyle?: CSSProperties;
  after?: ReactNode;
}) {
  const state = props.disabled ? "disabled" : props.checked ? "checked" : undefined;
  const tags = props.tags ?? [];
  const facts = tags.join(", ");
  const description =
    props.description && facts
      ? `${props.description}${/[.!?]$/.test(props.description) ? "" : "."} ${facts}`
      : props.description || facts || undefined;
  const card = (
    <button
      type="button"
      role="radio"
      aria-checked={props.checked}
      aria-label={props.label}
      aria-description={description}
      disabled={props.disabled}
      tabIndex={props.checked ? 0 : -1}
      onClick={props.onChoose}
      {...part("card", state, "picker")}
      className="group flex min-w-0 flex-col items-stretch gap-2 text-left outline-none disabled:cursor-not-allowed disabled:opacity-55"
    >
      <span
        {...part("card", state, "preview")}
        className={cn(
          "relative isolate block rounded-lg shadow-(--depth-raise)",
          "transition-transform duration-(--motion-base) ease-spring motion-reduce:transition-none",
          "motion-safe:group-enabled:group-hover:-translate-y-0.5 motion-safe:group-enabled:group-active:translate-y-0",
        )}
      >
        <span
          aria-hidden
          className={cn(
            layer,
            "-z-10 shadow-[0_10px_24px_-12px_rgb(0_0_0/0.55)] group-enabled:group-hover:opacity-100",
          )}
        />
        {props.preview}
        <span
          aria-hidden
          className={cn(
            ring,
            "border-ring group-aria-checked:scale-100 group-aria-checked:opacity-100",
          )}
        />
        <span
          aria-hidden
          className={cn(
            ring,
            "border-[var(--focus,var(--ring))] group-focus-visible:scale-100 group-focus-visible:opacity-100",
          )}
        />
      </span>
      <span aria-hidden className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span
          style={props.labelStyle}
          className="min-w-0 truncate text-sm text-muted-foreground transition-colors duration-(--motion-fast) group-enabled:group-hover:text-foreground group-aria-checked:text-foreground"
        >
          {props.label}
        </span>
        {tags.map((tag) => (
          <span
            key={tag}
            {...part("badge", undefined, "look")}
            className="rounded-full border border-border px-1.5 text-2xs leading-4 text-subtle-foreground"
          >
            {tag}
          </span>
        ))}
      </span>
    </button>
  );
  if (!props.after) return card;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1")}>
      {card}
      {props.after}
    </div>
  );
}
