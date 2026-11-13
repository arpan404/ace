import { agentPointerShownFor, type AgentPointer } from "@ace/ui-core/cowork";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { useWallClock } from "@/lib/time.ts";

/*
 * The agent's pointer wherever the person and an agent share a surface (a screen, a browser tab,
 * a simulator, a Spade bot's computer): where it last acted, fading ~1.5 s after that action.
 * Each view places it on its own picture; this is the mark and its timing.
 */

/**
 * Whether the pointer shows now: from its last action until it has faded. The clock is read only
 * when a new action arrives, and the pointer shows from the next tick (a stale one never does).
 */
export function useAgentPointerShown(pointer: AgentPointer | undefined): boolean {
  const wall = useWallClock();
  const at = pointer?.at;
  /** The action shown now, if any. */
  const [shown, setShown] = useState<number>();
  useEffect(() => {
    if (at === undefined) return;
    const left = agentPointerShownFor(pointer, wall());
    if (left <= 0) return;
    const show = setTimeout(() => setShown(at), 0);
    const fade = setTimeout(() => setShown((now) => (now === at ? undefined : now)), left);
    return () => {
      clearTimeout(show);
      clearTimeout(fade);
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- a new action is a new `at`
  }, [at, wall]);
  return at !== undefined && shown === at;
}

/**
 * The pointer itself: an arrow whose tip sits on the point (`style` places it, `left`/`top`), and
 * the agent's face or initial beside it. Hidden from the accessibility tree once faded. It never
 * takes input.
 */
export function AgentPointerMark(props: {
  /** Whose pointer, for its name: "Scout's pointer". */
  name: string;
  /** The face or initial drawn beside the arrow. */
  mark: ReactNode;
  shown: boolean;
  style: CSSProperties;
}) {
  return (
    <span
      role={props.shown ? "img" : undefined}
      aria-label={props.shown ? `${props.name}'s pointer` : undefined}
      aria-hidden={!props.shown}
      data-agent-pointer=""
      className={cn(
        "pointer-events-none absolute flex items-start transition-opacity duration-(--motion-slow)",
        props.shown ? "opacity-100" : "opacity-0",
      )}
      style={props.style}
    >
      <svg width="16" height="18" viewBox="0 0 16 18" aria-hidden className="drop-shadow-sm">
        <path
          d="M1.5 1.5v13.2l3.6-3.4 2.4 5.2 2.3-1-2.4-5.1h5.1z"
          className="fill-foreground stroke-background"
          strokeWidth="1.25"
          strokeLinejoin="round"
        />
      </svg>
      <span className="mt-3 -ml-1 grid size-5 place-items-center overflow-hidden rounded-full bg-foreground text-[10px] font-semibold text-background shadow-sm">
        {props.mark}
      </span>
    </span>
  );
}
