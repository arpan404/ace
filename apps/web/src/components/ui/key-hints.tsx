import { cn } from "@/lib/cn.ts";
import { formatKeys } from "@/lib/keymap.ts";
import { sectionRule } from "./rules.ts";

/**
 * Key hints under a keyboard-driven list (the palette, its steps, search): key caps, then what
 * they do here. Decoration only: hidden from assistive tech, which reads the controls' own names,
 * never focusable, and hidden on touch, where there are no keys to press. Show only the hints
 * that are true for the step on screen.
 */

/** Keys in keymap notation ("enter", "mod+enter"), any of which does `label`. */
export interface KeyHint {
  keys: readonly string[];
  label: string;
}

export const navigateHint: KeyHint = { keys: ["arrowup", "arrowdown"], label: "Navigate" };
export const selectHint: KeyHint = { keys: ["enter"], label: "Select" };
/** Backspace in an empty step field goes back a step; only where there is one to go back to. */
export const backHint: KeyHint = { keys: ["backspace"], label: "Back" };
export const closeHint: KeyHint = { keys: ["escape"], label: "Close" };

/** Esc in a palette step's field: clears the text first, closes once the field is empty. */
export function escapeHint(text: string): KeyHint {
  return text ? { keys: ["escape"], label: "Clear" } : closeHint;
}

/** The hints alone, for a footer that also holds the step's actions. */
export function KeyHintList(props: { hints: readonly KeyHint[]; className?: string }) {
  return (
    <div
      aria-hidden
      data-slot="key-hints"
      className={cn(
        "flex min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap select-none pointer-coarse:hidden",
        props.className,
      )}
    >
      {props.hints.map((hint) => (
        <span
          key={`${hint.label}:${hint.keys.join()}`}
          className="flex shrink-0 items-center gap-1"
        >
          {hint.keys.map((key) => (
            <kbd
              key={key}
              className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-xs bg-fill px-1 font-sans text-xs leading-none text-muted-foreground"
            >
              {formatKeys(key)}
            </kbd>
          ))}
          <span className="ml-0.5 text-xs text-subtle-foreground">{hint.label}</span>
        </span>
      ))}
    </div>
  );
}

/** A bar of hints along a sheet's bottom edge, under its list. */
export function KeyHints(props: { hints: readonly KeyHint[] }) {
  return (
    <div
      aria-hidden
      className={cn("flex h-9 shrink-0 items-center px-3 pointer-coarse:hidden", sectionRule)}
    >
      <KeyHintList hints={props.hints} />
    </div>
  );
}
