import { m, useReducedMotion } from "motion/react";

import { cn } from "~/lib/utils";
import type { ThreadBoardDropDirection } from "./threadBoardTypes";

const BOARD_DROP_TRANSITION = { duration: 0.07, ease: [0.16, 1, 0.3, 1] } as const;
const BOARD_REDUCED_MOTION_TRANSITION = { duration: 0 } as const;

export function ThreadBoardDropPreview(props: { direction: ThreadBoardDropDirection }) {
  const reducedMotion = useReducedMotion();
  const transition = reducedMotion ? BOARD_REDUCED_MOTION_TRANSITION : BOARD_DROP_TRANSITION;
  const frameClassName =
    props.direction === "left"
      ? "right-1/2 w-1/2"
      : props.direction === "right"
        ? "left-1/2 w-1/2"
        : props.direction === "up"
          ? "bottom-1/2 h-1/2"
          : "top-1/2 h-1/2";

  return (
    <m.div
      className="pointer-events-none absolute inset-0 z-30 rounded-[inherit]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={transition}
      aria-hidden="true"
    >
      <div className="absolute inset-0 rounded-[inherit] border border-primary/28 bg-primary/[0.04]" />
      <m.div
        className={cn(
          "absolute z-[31] rounded-[inherit] border border-primary/35 bg-primary/[0.08]",
          props.direction === "left" || props.direction === "right"
            ? "top-0 bottom-0"
            : "left-0 right-0",
          frameClassName,
        )}
        initial={{ opacity: 0, scale: 0.985 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.99 }}
        transition={transition}
      />
    </m.div>
  );
}

export function ThreadBoardDropHint(props: { isSinglePane: boolean }) {
  const reducedMotion = useReducedMotion();
  const transition = reducedMotion ? BOARD_REDUCED_MOTION_TRANSITION : BOARD_DROP_TRANSITION;
  return (
    <m.div
      className="pointer-events-none absolute inset-0 z-20 rounded-[inherit]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={transition}
      aria-hidden="true"
    >
      <div className="absolute inset-0 rounded-[inherit] border border-dashed border-primary/28 bg-primary/[0.03]" />
      <m.div
        className="absolute inset-x-3 top-3 z-[32] flex justify-center"
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -2 }}
        transition={transition}
      >
        <div className="glass-surface glass-surface--compact rounded-full border border-primary/25 px-2.5 py-1 text-[10px] font-medium tracking-[0.12em] text-primary/80 uppercase">
          {props.isSinglePane ? "Drop to create split" : "Drop to add pane"}
        </div>
      </m.div>
    </m.div>
  );
}
