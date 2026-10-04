export const countButton =
  "inline-flex h-[30px] min-w-[30px] items-center justify-center rounded-md px-1.5 text-muted-foreground outline-none transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)] aria-expanded:bg-accent aria-expanded:text-foreground";

/** The count itself: a small outlined numeral, like a stack of tabs. */
export function CountMark(props: { count: number }) {
  return (
    <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] px-1 text-[11px] leading-none font-semibold tabular-nums shadow-[inset_0_0_0_1.5px_currentColor]">
      {props.count}
    </span>
  );
}
