import type { CSSProperties, ReactNode } from "react";
import { CheckIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";

/**
 * One choice in the mode or theme picker: a radio that is the preview's frame, its name beneath.
 * Resting it is a quiet card; hovering washes and lifts it a hair, and the chosen card takes an
 * inset accent ring on a tinted wash with a soft lift shadow. The name sits left with a filled
 * check beside it, or centered with the ring alone marking the choice (`centerLabel`, the mode
 * cards). The name is the accessible label, so the preview stays decoration.
 */
export function PickerCard(props: {
  label: string;
  description?: string;
  checked: boolean;
  onChoose: () => void;
  preview: ReactNode;
  /** The name's font, e.g. the theme's own interface face. */
  labelStyle?: CSSProperties;
  /** Center the name and let the ring alone mark the choice. */
  centerLabel?: boolean;
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
      className="group flex min-w-0 flex-col gap-2 rounded-card border border-border bg-card p-2 text-left outline-none transition-[translate,border-color,background-color,box-shadow,outline-color] duration-(--motion-base) hover:border-border-strong hover:bg-fill hover:shadow-[0_16px_32px_-24px_rgb(0_0_0/0.5)] motion-safe:hover:-translate-y-px aria-checked:bg-tint/10 aria-checked:shadow-[0_16px_32px_-20px_rgb(0_0_0/0.55)] aria-checked:outline-2 aria-checked:-outline-offset-2 aria-checked:outline-ring aria-checked:outline-solid focus-visible:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--focus)]"
    >
      {props.preview}
      <span
        className={cn(
          "flex min-h-5 items-center gap-2 px-1.5 pb-1",
          props.centerLabel && "justify-center px-2",
        )}
      >
        <span
          aria-hidden
          style={props.labelStyle}
          className={cn(
            "min-w-0 truncate text-sm text-muted-foreground group-aria-checked:font-medium group-aria-checked:text-foreground",
            !props.centerLabel && "flex-1",
          )}
        >
          {props.label}
        </span>
        {props.checked && !props.centerLabel && (
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
