import { PushPinIcon, XIcon } from "@ace/icons";
import { cn } from "@/lib/cn.ts";

/** What a tab's (or Open editors row's) one slot shows, in the spec's priority order (21). */
export type SlotShows = "unsaved" | "pinned" | "close" | "none";

export function slotShows(
  unsaved: boolean,
  pinned: boolean,
  /** Pointer over the tab, focus in it, or the tab is the group's active one. */
  revealed: boolean,
  hovered: boolean,
): SlotShows {
  // The unsaved dot turns into × only under the pointer, so a glance never hides it.
  if (unsaved) return hovered ? "close" : "unsaved";
  if (revealed) return "close";
  if (pinned) return "pinned";
  return "none";
}

/**
 * The 18px slot at a tab's end. It is always the tab's close button, so the strip never shifts
 * and one click on the dot closes as × would; what it draws says the tab's state.
 */
export function TabSlot(props: {
  shows: SlotShows;
  unsaved: boolean;
  name: string;
  onClose(): void;
}) {
  const { shows } = props;
  return (
    <button
      type="button"
      tabIndex={-1}
      data-shows={shows}
      aria-label={props.unsaved ? `Close ${props.name}, unsaved` : `Close ${props.name}`}
      onClick={(event) => {
        event.stopPropagation();
        props.onClose();
      }}
      className={cn(
        "grid size-[18px] shrink-0 place-items-center rounded-xs text-subtle-foreground outline-none",
        "transition-[background-color,color] duration-(--motion-fast) hover:bg-accent hover:text-foreground",
        shows === "unsaved" && "text-current",
      )}
    >
      {shows === "unsaved" && <span aria-hidden className="size-2 rounded-full bg-current" />}
      {shows === "close" && <XIcon aria-hidden size={12} weight="bold" />}
      {shows === "pinned" && <PushPinIcon aria-hidden size={12} />}
    </button>
  );
}
