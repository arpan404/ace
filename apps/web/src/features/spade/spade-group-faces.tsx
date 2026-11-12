import type { SpadeAvatar } from "@ace/ui-core/spade-chat";
import { cn } from "@/lib/cn.ts";
import { SpadeFace } from "./spade-face.tsx";

/** Where each of up to three faces sits in the box, as fractions of its side. */
const places: Record<number, readonly { left: number; top: number }[]> = {
  2: [
    { left: 0, top: 0 },
    { left: 0.4, top: 0.4 },
  ],
  3: [
    { left: 0.2, top: 0 },
    { left: 0, top: 0.4 },
    { left: 0.4, top: 0.4 },
  ],
};

/**
 * A group's face: up to three members' faces stacked in one square, each cut from the next by
 * the panel's colour; an away member's dimmed. Decorative, like a bot's face: its row names it.
 */
export function GroupFaces(props: {
  members: readonly { agent: string; avatar: SpadeAvatar; away: boolean }[];
  size: number;
  className?: string | undefined;
}) {
  const shown = props.members.slice(0, 3);
  const { size } = props;
  if (shown.length < 2) {
    const [only] = shown;
    return only ? (
      <SpadeFace
        avatar={only.avatar}
        size={size}
        className={cn(only.away && "opacity-45", props.className)}
      />
    ) : (
      <span aria-hidden className="shrink-0" style={{ width: size, height: size }} />
    );
  }
  const face = Math.round(size * 0.6);
  return (
    <span
      aria-hidden
      data-group-faces={shown.length}
      className={cn("relative shrink-0", props.className)}
      style={{ width: size, height: size }}
    >
      {shown.map((member, index) => {
        const place = places[shown.length]?.[index] ?? { left: 0, top: 0 };
        return (
          <span
            key={`${index}:${member.agent}`}
            className="absolute grid rounded-full shadow-[0_0_0_1.5px_var(--sidebar-panel)]"
            style={{ left: place.left * size, top: place.top * size }}
          >
            <SpadeFace
              avatar={member.avatar}
              size={face}
              className={cn(member.away && "opacity-45")}
            />
          </span>
        );
      })}
    </span>
  );
}
