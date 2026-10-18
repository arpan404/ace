/*
 * A message's actions (its time, Copy, Edit, Retry, Fork): revealed while the message is hovered
 * or holds focus, and always on touch, where nothing hovers. Class names are whole literals so
 * Tailwind finds them.
 */

const reveal: Record<"bubble" | "answer", string> = {
  bubble:
    "flex h-6 items-center gap-2 opacity-0 transition-opacity duration-(--motion-fast) group-hover/bubble:opacity-100 group-focus-within/bubble:opacity-100 pointer-coarse:opacity-100",
  answer:
    "flex h-6 items-center gap-2 opacity-0 transition-opacity duration-(--motion-fast) group-hover/answer:opacity-100 group-focus-within/answer:opacity-100 pointer-coarse:opacity-100",
};

/** The actions row's classes for a person's bubble or an agent's answer. */
export function messageActions(of: "bubble" | "answer"): string {
  return reveal[of];
}
