import type { CSSProperties, ReactNode } from "react";
import { CheckIcon } from "@phosphor-icons/react";

/**
 * One choice in the mode or theme picker: a radio that is the preview's frame, its name beneath.
 * The chosen card takes a 2px accent ring set 2px off its edge and a filled check beside its
 * name; hovering lifts it a hair. Its name is its accessible label, so the preview stays
 * decoration.
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
      className="group flex min-w-0 flex-col gap-2 rounded-card border border-border bg-card p-1.5 text-left outline-none transition-[translate,border-color,outline-color] duration-(--motion-base) hover:border-border-strong motion-safe:hover:-translate-y-px aria-checked:outline-2 aria-checked:outline-offset-2 aria-checked:outline-ring aria-checked:outline-solid focus-visible:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--focus)]"
    >
      {props.preview}
      <span className="flex min-h-5 items-center gap-2 px-1.5 pb-1">
        <span
          aria-hidden
          style={props.labelStyle}
          className="min-w-0 flex-1 truncate text-sm text-muted-foreground group-aria-checked:font-medium group-aria-checked:text-foreground"
        >
          {props.label}
        </span>
        {props.checked && (
          <span
            aria-hidden
            className="grid size-4.5 shrink-0 place-items-center rounded-full bg-tint text-tint-foreground"
          >
            <CheckIcon weight="bold" className="size-2.5" />
          </span>
        )}
      </span>
    </button>
  );
}
