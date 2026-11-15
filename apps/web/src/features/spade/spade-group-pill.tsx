import { GroupFaces } from "./spade-group-faces.tsx";
import { conversationPill } from "./spade-pill.tsx";
import type { ShownMember } from "./use-spade-groups.ts";

/**
 * The pill over a group's conversation, as a bot's is: the members' faces stacked (moving while
 * they work) and the group's name. It opens the group's profile.
 */
export function GroupPill(props: {
  name: string;
  members: readonly ShownMember[];
  /** The profile is open: the pill says so and closes it. */
  open: boolean;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      onClick={props.onToggle}
      aria-expanded={props.open}
      aria-label={`${props.name}: ${props.open ? "close" : "open"} its profile`}
      className={conversationPill}
    >
      <GroupFaces members={props.members} size={28} className="[--faces-cut:transparent]" />
      <span className="min-w-0 truncate">{props.name}</span>
    </button>
  );
}
