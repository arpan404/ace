import { cn } from "@/lib/cn.ts";

/**
 * A 6px status dot in its tone's hue (`data-tone`, see index.css): needs you, working, failed,
 * done, idle; a hollow ring when unresponsive. Held at a usage limit, a thread waits on its
 * provider, not on the person, so its dot is a hollow ring in the waiting tone, the same tone as
 * its Limited label. Always paired with text for assistive tech (`label`).
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

export { Dot };
