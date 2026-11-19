import type { AgentPointer } from "@ace/ui-core/cowork";
import type { ReactNode } from "react";
import { AgentPointerMark, useAgentPointerShown } from "@/components/agent-pointer.tsx";
import { cn } from "@/lib/cn.ts";

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
  const shown = useAgentPointerShown(pointer);
  if (!pointer || !props.width || !props.height) return null;
  const inside =
    pointer.x >= 0 && pointer.y >= 0 && pointer.x <= props.width && pointer.y <= props.height;
  if (!inside) return null;
  return (
    <div
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
        <AgentPointerMark
          name={props.name}
          mark={props.mark}
          shown={shown}
          style={{
            left: `${percent(pointer.x / props.width)}%`,
            top: `${percent(pointer.y / props.height)}%`,
          }}
        />
      </div>
    </div>
  );
}

const percent = (fraction: number) => Math.round(fraction * 10_000) / 100;
