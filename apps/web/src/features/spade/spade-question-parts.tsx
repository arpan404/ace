import { cn } from "@/lib/cn.ts";

/* The rows a question card's inputs share: an option, its circle, its digit key, a field. */

/** An option: a quiet row on the card's block, its letter key first; no edge until focused. */
export const optionRow =
  "flex min-h-10 w-full min-w-0 items-center gap-3 rounded-xl px-1 py-1.5 text-left text-base leading-5 transition-colors duration-(--motion-fast) focus-ring hover:bg-hover pointer-coarse:min-h-11";
export const optionChosen = "text-foreground";

/** A field in the card: 40px in the card's well, at the answers' size; refused, its edge is red. */
export const well =
  "rounded-lg bg-chat-well px-3 text-base shadow-[inset_0_0_0_1px_var(--border-strong)] aria-invalid:shadow-[inset_0_0_0_1px_var(--destructive)]";

/** The letter an option answers to: A, B, C… (undefined past Z). */
export const optionLetter = (index: number) =>
  index < 26 ? String.fromCharCode(65 + index) : undefined;

/** An option's letter key, a small rounded square; filled in ink once chosen. */
export function LetterKey(props: { letter: string | undefined; on?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-lg text-sm leading-none shadow-[inset_0_0_0_1px_var(--border-strong)] transition-colors duration-(--motion-fast)",
        props.on
          ? "bg-foreground text-background shadow-none"
          : "bg-chat-well text-muted-foreground",
      )}
    >
      {props.letter}
    </span>
  );
}
