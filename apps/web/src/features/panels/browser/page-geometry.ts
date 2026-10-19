/** A box in the page's CSS pixels: the frame's coordinate space, as forwarded input uses. */
export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ScreenBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a page box is drawn, in the same coordinates as `picture` (the frame's rendered box):
 * the inverse of how pointer positions map back to page pixels.
 */
export function pageToScreen(
  box: PageBox,
  picture: ScreenBox,
  frame: { width: number; height: number },
): ScreenBox {
  const scale = frame.width ? picture.width / frame.width : 1;
  return {
    left: picture.left + box.x * scale,
    top: picture.top + box.y * scale,
    width: box.width * scale,
    height: box.height * scale,
  };
}

/** The same box measured from `origin`'s top-left corner (for drawing inside the pane). */
export function relativeTo(box: ScreenBox, origin: { left: number; top: number }): ScreenBox {
  return { ...box, left: box.left - origin.left, top: box.top - origin.top };
}
