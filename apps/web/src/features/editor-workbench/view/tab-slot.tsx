import { PushPinIcon, XIcon } from "@ace/icons";
import type { ProviderKind } from "@ace/protocol";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { cn } from "@/lib/cn.ts";

/** What a tab's (or Open editors row's) one slot shows, in the spec's priority order (21). */
export type SlotShows = "unsaved" | "agent" | "pinned" | "close" | "none";

export function slotShows(
  unsaved: boolean,
  pinned: boolean,
  /** Pointer over the tab, focus in it, or the tab is the group's active one. */
  revealed: boolean,
  hovered: boolean,
  /** An agent changed the file and the person hasn't looked since. */
  agent = false,
): SlotShows {
  // The unsaved dot and the agent's mark turn into × only under the pointer, so a glance never
  // hides them.
  if (unsaved) return hovered ? "close" : "unsaved";
  if (agent) return hovered ? "close" : "agent";
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
  /** Whose mark "agent" draws; without a provider it is a dot in the working colour. */
  provider?: ProviderKind | undefined;
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
      {shows === "agent" &&
        (props.provider ? (
          <ProviderIcon provider={props.provider} size={12} decorative />
        ) : (
          <span aria-hidden className="size-1.5 rounded-full bg-status-working" />
        ))}
    </button>
  );
}
