import type { CSSProperties, ReactNode } from "react";
import { CheckIcon } from "@phosphor-icons/react";

/**
 * One choice in the mode or theme picker: a radio holding a preview, its name beneath. The chosen
 * card takes a 2px ring in the accent and a check in the preview's corner; hovering lifts it a
 * hair. Its name is its accessible label, so the preview stays decoration.
 */
export function PickerCard(props: {
  label: string;
  description?: string;
  checked: boolean;
  onChoose: () => void;
  preview: ReactNode;
  /** The name's font, e.g. the theme's own interface face. */
  labelStyle?: CSSProperties;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.checked}
      aria-label={props.label}
      aria-description={props.description}
      tabIndex={props.checked ? 0 : -1}
      onClick={props.onChoose}
      className="group relative flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-card p-1.5 text-left outline-none transition-[translate,border-color,box-shadow] duration-(--motion-base) hover:border-border-strong motion-safe:hover:-translate-y-px aria-checked:border-transparent aria-checked:shadow-[0_0_0_2px_var(--ring)] focus-visible:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--focus)]"
    >
      <span className="relative block">
        {props.preview}
        {props.checked && (
          <span
            aria-hidden
            className="absolute top-1.5 right-1.5 grid size-4.5 place-items-center rounded-full bg-tint text-tint-foreground shadow-[0_0_0_2px_var(--card)]"
          >
            <CheckIcon weight="bold" className="size-2.5" />
          </span>
        )}
      </span>
      <span
        aria-hidden
        style={props.labelStyle}
        className="truncate px-1 pb-0.5 text-sm text-muted-foreground group-aria-checked:font-medium group-aria-checked:text-foreground"
      >
        {props.label}
      </span>
    </button>
  );
}
