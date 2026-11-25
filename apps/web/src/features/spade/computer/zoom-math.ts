/** A frame's zoom (1 is Fit) and its pan, in px, from its top-left corner. */
export interface ZoomView {
  scale: number;
  x: number;
  y: number;
}

export const fitView: ZoomView = { scale: 1, x: 0, y: 0 };

const minZoom = 1;
const maxZoom = 8;

export const clampZoom = (scale: number) => Math.min(maxZoom, Math.max(minZoom, scale));

interface Size {
  width: number;
  height: number;
}

/** Keeps the zoomed picture covering the frame: no gap shows past its edges. */
function covering(view: ZoomView, size: Size): ZoomView {
  const x = Math.min(0, Math.max(size.width * (1 - view.scale), view.x));
  const y = Math.min(0, Math.max(size.height * (1 - view.scale), view.y));
  return { scale: view.scale, x, y };
}

/** Zooms to `scale`, keeping the point `at` (in the frame) where it is. */
export function zoomAt(view: ZoomView, scale: number, at: { x: number; y: number }, size: Size) {
  const next = clampZoom(scale);
  if (next === 1) return fitView;
  const ratio = next / view.scale;
  return covering(
    { scale: next, x: at.x - (at.x - view.x) * ratio, y: at.y - (at.y - view.y) * ratio },
    size,
  );
}

/** Moves the picture by `by`, within its edges. */
export function panBy(view: ZoomView, by: { x: number; y: number }, size: Size): ZoomView {
  return covering({ ...view, x: view.x + by.x, y: view.y + by.y }, size);
}
