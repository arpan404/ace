import { useEffect, useState } from "react";
import type { ScreenFrame } from "../sources.ts";
import type { FrozenPage } from "./native-view.ts";

/**
 * The still taken as a menu covered the native page, while it still has to stand in for the
 * page: until the live video brings a picture newer than the one there was when the still was
 * taken. From then on the live pictures draw the page under the menu (the native view keeps
 * rendering, parked, while it is out of the way), so a playing video keeps moving.
 */
export function useCoverStill(
  still: FrozenPage | undefined,
  frame: ScreenFrame | undefined,
): FrozenPage | undefined {
  /** The picture there was when the still arrived, and whether a newer one came since. */
  const [held, setHeld] = useState({ still, frame, newer: false });
  if (held.still !== still) setHeld({ still, frame, newer: false });
  const current = held.still === still ? held : { still, frame, newer: false };
  const watched = still && frame && frame === current.frame ? frame : undefined;
  useEffect(() => {
    if (!watched) return;
    // One render once a newer picture lands, not one per picture.
    const stop = watched.subscribe(() => {
      stop();
      setHeld((before) => (before.frame === watched ? { ...before, newer: true } : before));
    });
    return stop;
  }, [watched]);
  if (!still) return undefined;
  if (!frame) return still;
  return frame === current.frame && !current.newer ? still : undefined;
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
