import { ArrowDownIcon } from "@ace/icons";
import { Icon } from "@/components/icon.tsx";
import { floatingControl, floatingHover, floatingMotion } from "@/components/floating-control.ts";
import { cn } from "@/lib/cn.ts";

/**
 * Back to the latest message: a small round pill with a down arrow, centred above the composer
 * with a gap, layered over the transcript but under a bubble's own actions. With messages that
 * arrived since the person scrolled up, a count sits beside the arrow.
 */
export function SpadeEndPill(props: {
  unread: number;
  /** Leaving: it plays its exit and takes no input. */
  phase: "enter" | "exit";
  onClick(): void;
}) {
  const leaving = props.phase === "exit";
  const label = props.unread > 0 ? `Scroll to end, ${props.unread} new` : "Scroll to end";
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={label}
      aria-hidden={leaving || undefined}
      inert={leaving}
      className={cn(
        floatingControl,
        floatingMotion(props.phase),
        floatingHover,
        "absolute bottom-[min(calc(var(--composer-clearance,0px)+0.25rem),calc(100%-2.75rem))] left-1/2 z-10 h-9 min-w-9 -translate-x-1/2 justify-center text-foreground",
        props.unread > 0 ? "gap-1.5 px-3" : "w-9",
        "transition-[background-color,box-shadow] duration-(--motion-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "touch-hit",
      )}
    >
      <Icon icon={ArrowDownIcon} size={16} />
      {props.unread > 0 && (
        <span className="text-xs font-medium tabular-nums" aria-hidden>
          {props.unread > 99 ? "99+" : props.unread}
        </span>
      )}
    </button>
  );
}
