import { cn } from "@/lib/cn.ts";

/**
 * A 6px status dot in its tone's hue (`data-tone`, see index.css): needs you, working, failed,
 * done, idle; a hollow ring when unresponsive. Held at a usage limit, a thread waits on its
 * provider, not on the person, so its dot is a hollow ring in the waiting tone, the same tone as
 * its Limited pill. Always paired with text for assistive tech (`label`).
 */
function Dot(props: {
  tone: "needs-you" | "working" | "failed" | "unresponsive" | "limited" | "idle" | "done";
  label?: string;
  className?: string;
}) {
  return (
    <span
      data-slot="dot"
      data-tone={props.tone === "limited" ? "waiting" : props.tone}
      {...(props.label ? { role: "img", "aria-label": props.label } : { "aria-hidden": true })}
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        props.tone === "unresponsive" || props.tone === "limited"
          ? "shadow-[inset_0_0_0_1.5px_var(--tone)]"
          : "bg-(--tone)",
        props.className,
      )}
    />
  );
}

/** Needs-you count on the sidebar's bell. Hidden at zero. */
function CountBadge(props: { count: number; label: string; className?: string }) {
  if (props.count <= 0) return null;
  return (
    <span
      data-slot="count-badge"
      aria-label={props.label}
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-status-needs-you px-1 text-[10px] leading-4 font-bold text-[#1E1306] shadow-[0_0_0_2px_var(--sidebar)]",
        props.className,
      )}
    >
      {props.count > 99 ? "99+" : props.count}
    </span>
  );
}

export { Dot, CountBadge };
