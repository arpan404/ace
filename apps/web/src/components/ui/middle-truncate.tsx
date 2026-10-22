import { cn } from "@/lib/cn.ts";

/**
 * Text that, when it doesn't fit, loses its middle instead of its end: "ace/settle-st…s-chains".
 * The head shrinks with an ellipsis while the last `tail` characters always stay visible, so
 * names that differ only at the end (branches, worktrees) stay told apart. Pure CSS, no measuring.
 */
export function MiddleTruncate(props: { text: string; tail?: number; className?: string }) {
  const chars = Array.from(props.text);
  const keep = Math.min(props.tail ?? 8, Math.max(0, chars.length - 1));
  const head = chars.slice(0, chars.length - keep).join("");
  const end = chars.slice(chars.length - keep).join("");
  return (
    <span className={cn("flex min-w-0", props.className)} title={props.text}>
      <span className="min-w-0 truncate whitespace-pre">{head}</span>
      {end && <span className="shrink-0 whitespace-pre">{end}</span>}
    </span>
  );
}
