import { agentPointerShownFor, type AgentPointer } from "@ace/ui-core/cowork";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { useWallClock } from "@/lib/time.ts";

/**
 * The agent's pointer over a live picture while the person and the agent share it: a small cursor
 * with the agent's face (or initial) where it last acted, fading ~1.5 s after that action. It sits
 * over a picture drawn `object-contain` in the same box (`align` `top` for a page under its address
 * bar), in the pointer's own coordinates (`width` × `height`, the picture's size in them). It never
 * takes the person's input.
 */
export function AgentCursor(props: {
  pointer: AgentPointer | undefined;
  width: number;
  height: number;
  /** Whose pointer, for its name: "Scout's pointer". */
  name: string;
  /** The face or initial drawn beside the arrow. */
  mark: ReactNode;
  align?: "center" | "top";
}) {
  const { pointer } = props;
  const shown = useShown(pointer);
  if (!pointer || !props.width || !props.height) return null;
  const inside =
    pointer.x >= 0 && pointer.y >= 0 && pointer.x <= props.width && pointer.y <= props.height;
  if (!inside) return null;
  return (
    <div
      aria-hidden={!shown}
      className={cn(
        "pointer-events-none absolute inset-0 flex justify-center",
        props.align === "top" ? "items-start" : "items-center",
      )}
      style={{ containerType: "size" }}
    >
      {/* The picture's drawn box: as wide as fits both ways, at the picture's own shape. */}
      <div
        className="relative"
        style={{
          width: `min(100cqw, calc(100cqh * ${props.width / props.height}))`,
          aspectRatio: `${props.width} / ${props.height}`,
        }}
      >
        <div
          role="img"
          aria-label={`${props.name}'s pointer`}
          className={cn(
            "absolute flex items-start transition-opacity duration-(--motion-slow)",
            shown ? "opacity-100" : "opacity-0",
          )}
          style={{
            left: `${percent(pointer.x / props.width)}%`,
            top: `${percent(pointer.y / props.height)}%`,
          }}
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
        </div>
      </div>
    </div>
  );
}

const percent = (fraction: number) => Math.round(fraction * 10_000) / 100;

/**
 * Whether the pointer shows now: from its last action until it has faded. The clock is read only
 * when a new action arrives, and the pointer shows from the next tick (a stale one never does).
 */
function useShown(pointer: AgentPointer | undefined): boolean {
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
