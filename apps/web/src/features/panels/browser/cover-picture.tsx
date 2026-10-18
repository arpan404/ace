import { useState } from "react";
import type { FrozenPage } from "./native-view.ts";

/**
 * The still taken as a menu covered the native page, while it still has to stand in for the
 * page: until the daemon's screencast brings a frame other than the one there was when the
 * still was taken. From then on the live frames draw the page under the menu (the native view
 * keeps rendering, parked, while it is out of the way), so a playing video keeps moving.
 */
export function coverStill(input: {
  still: FrozenPage | undefined;
  /** The screencast frame there was when the still was taken. */
  frameAtStill: number | undefined;
  frame: number | undefined;
}): FrozenPage | undefined {
  if (!input.still) return undefined;
  return input.frame === undefined || input.frame === input.frameAtStill ? input.still : undefined;
}

/** `coverStill` for a component: remembers the frame there was when each still arrived. */
export function useCoverStill(
  still: FrozenPage | undefined,
  frame: number | undefined,
): FrozenPage | undefined {
  const [held, setHeld] = useState({ still, frame });
  if (held.still !== still) {
    setHeld({ still, frame });
    return still;
  }
  return coverStill({ still, frameAtStill: held.frame, frame });
}

/** The native page's still, exactly where the page is, while a menu covers it. */
export function CoverPicture(props: { still: FrozenPage }) {
  const { still } = props;
  return (
    <img
      data-frozen-page=""
      src={still.src}
      alt=""
      aria-hidden
      draggable={false}
      style={{
        left: still.box.x,
        top: still.box.y,
        width: still.box.width,
        height: still.box.height,
      }}
      className="pointer-events-none absolute max-w-none select-none"
    />
  );
}
