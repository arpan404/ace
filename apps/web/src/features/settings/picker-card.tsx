import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";

/**
 * One choice in the mode or look picker: a radio that is its preview, its name beneath. No card
 * around it: the preview is the thing chosen. Hovering lifts the preview a hair; the chosen one
 * takes the accent ring a 2px gap outside its edge, and its name turns to full ink. The name is
 * the accessible label, so the preview stays decoration. A disabled choice is dimmed and skipped
 * by the arrow keys; `after` (what it needs fixed) sits under it, outside the radio.
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
        className={
          "block rounded-lg shadow-(--depth-raise) transition-[translate,box-shadow] duration-(--motion-base) motion-safe:group-enabled:group-hover:-translate-y-px " +
          "group-enabled:group-hover:shadow-[0_6px_16px_-8px_rgb(0_0_0/0.35)] " +
          "group-aria-checked:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--ring)] " +
          "group-focus-visible:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--focus)]"
        }
      >
        {props.preview}
      </span>
      <span aria-hidden className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span
          style={props.labelStyle}
          className="min-w-0 truncate text-sm text-muted-foreground transition-colors duration-(--motion-fast) group-enabled:group-hover:text-foreground group-aria-checked:font-medium group-aria-checked:text-foreground"
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
