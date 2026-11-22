import { cn } from "@/lib/cn.ts";

/* The rows a question card's inputs share: an option, its circle, its digit key, a field. */

/** An option: a 40px row with its edge, the chosen one's edge in ink. */
export const optionRow =
  "flex min-h-10 w-full min-w-0 items-start gap-3 rounded-lg px-3 py-2.5 text-left text-base leading-5 shadow-[inset_0_0_0_1px_var(--border-strong)] transition-[background-color,box-shadow] duration-(--motion-fast) focus-ring hover:bg-hover pointer-coarse:min-h-11 pointer-coarse:items-center";
export const optionChosen = "text-foreground shadow-[inset_0_0_0_1.5px_var(--foreground)]";

/** A field in the card: 40px in the card's well, at the answers' size; refused, its edge is red. */
export const well =
  "rounded-lg bg-chat-well px-3 text-base shadow-[inset_0_0_0_1px_var(--border-strong)] aria-invalid:shadow-[inset_0_0_0_1px_var(--destructive)]";

/** An option's digit key, at the row's end. */
export function DigitKey(props: { digit: string | undefined }) {
  if (!props.digit) return null;
  return (
    <span
      aria-hidden
      className="ml-auto shrink-0 pl-3 text-xs leading-5 text-subtle-foreground tabular-nums pointer-coarse:hidden"
    >
      {props.digit}
    </span>
  );
}

/** A pick-one option's circle, filled in ink once chosen. */
export function Radio(props: { on: boolean }) {
  return (
    <span className="flex h-5 shrink-0 items-center">
      <span
        aria-hidden
        className={cn(
          "size-4 rounded-full transition-shadow duration-(--motion-fast)",
          props.on
            ? "shadow-[inset_0_0_0_5px_var(--foreground)]"
            : "shadow-[inset_0_0_0_1.5px_var(--border-strong)]",
        )}
      />
    </span>
  );
}
