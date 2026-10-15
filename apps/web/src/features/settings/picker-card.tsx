import type { CSSProperties, ReactNode } from "react";

/**
 * One choice in the mode or theme picker: a radio that is its preview, its name centred beneath.
 * No card around it: the preview is the thing chosen. Hovering lifts the preview a hair; the
 * chosen one takes the accent ring a 2px gap outside its edge, and its name turns to full ink. The
 * name is the accessible label, so the preview stays decoration.
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
      className="group flex min-w-0 flex-col items-stretch gap-2 text-center outline-none"
    >
      <span
        className={
          "block rounded-lg shadow-(--depth-raise) transition-[translate,box-shadow] duration-(--motion-base) motion-safe:group-hover:-translate-y-px " +
          "group-hover:shadow-[0_6px_16px_-8px_rgb(0_0_0/0.35)] " +
          "group-aria-checked:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--ring)] " +
          "group-focus-visible:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--focus)]"
        }
      >
        {props.preview}
      </span>
      <span
        aria-hidden
        style={props.labelStyle}
        className="min-w-0 truncate text-sm text-muted-foreground transition-colors duration-(--motion-fast) group-hover:text-foreground group-aria-checked:font-medium group-aria-checked:text-foreground"
      >
        {props.label}
      </span>
    </button>
  );
}
