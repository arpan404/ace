import { ArrowDownIcon } from "@phosphor-icons/react";

/**
 * Back to the live end. It says how many items arrived since the reader left it, and that
 * following is paused while the agent works.
 */
export function LivePill(props: {
  newItems: number;
  /** More arrived than the live window holds. */
  more: boolean;
  paused: boolean;
  onClick(): void;
}) {
  const count = props.newItems
    ? `${props.newItems.toLocaleString("en-US")}${props.more ? "+" : ""} new`
    : "";
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={count ? `Jump to live, ${count}` : "Jump to live"}
      className="fx-rise-in glass absolute bottom-3 left-1/2 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-muted-foreground transition-colors duration-(--dur-1) hover:text-foreground"
    >
      <ArrowDownIcon aria-hidden size={14} />
      {props.paused && (
        <span className="font-normal text-subtle-foreground">Following paused ·</span>
      )}
      Jump to live
      {count && (
        <span className="rounded-full bg-[color-mix(in_oklab,var(--ring)_22%,transparent)] px-1.5 text-xs tabular-nums text-foreground">
          {count}
        </span>
      )}
    </button>
  );
}
