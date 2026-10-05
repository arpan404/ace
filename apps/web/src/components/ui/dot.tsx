import { cn } from "@/lib/cn.ts";

/**
 * The only colour a list row carries: a 6px dot when a thread needs you or failed, a hollow
 * grey dot when unresponsive, a hollow amber one when held at a usage limit. Always paired with
 * text for assistive tech (`label`).
 */
function Dot(props: {
  tone: "needs-you" | "failed" | "unresponsive" | "limited" | "idle" | "done";
  label?: string;
  className?: string;
}) {
  return (
    <span
      data-slot="dot"
      data-tone={props.tone}
      {...(props.label ? { role: "img", "aria-label": props.label } : { "aria-hidden": true })}
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        props.tone === "needs-you" && "bg-status-needs-you",
        props.tone === "failed" && "bg-status-failed",
        props.tone === "done" && "bg-status-done",
        props.tone === "idle" && "bg-subtle-foreground",
        props.tone === "unresponsive" && "shadow-[inset_0_0_0_1.5px_var(--subtle-foreground)]",
        props.tone === "limited" && "shadow-[inset_0_0_0_1.5px_var(--status-needs-you)]",
        props.className,
      )}
    />
  );
}

/** Needs-you count on the rail. Hidden at zero. */
function CountBadge(props: { count: number; label: string; className?: string }) {
  if (props.count <= 0) return null;
  return (
    <span
      data-slot="count-badge"
      aria-label={props.label}
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-status-needs-you px-1 text-[10px] leading-4 font-bold text-[#1E1306] shadow-[0_0_0_2px_var(--rail)]",
        props.className,
      )}
    >
      {props.count > 99 ? "99+" : props.count}
    </span>
  );
}

export { Dot, CountBadge };
