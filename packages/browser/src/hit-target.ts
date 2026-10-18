import { z } from "zod";
import { BrowserActionError } from "./action-error.ts";

/*
 * Where an agent's pointer may land on an element (ADR 0067, "Clicks land where they aim").
 * Runs on the element (`this`) in its own document: it scrolls the element into view, waits
 * until the centre of its box holds still for two frames, then hit-tests candidate points inside the
 * visible part of the box (centre first) and returns the first one where the element itself,
 * a descendant, or one of its labels is what the pointer would hit.
 */
export const hitTargetFunction = `async function() {
  if (!this.isConnected) throw new Error('detached');
  const doc = this.ownerDocument;
  const view = doc.defaultView;
  // A frame, or a short timer where frames do not run (a hidden tab).
  const frame = () => new Promise((resolve) => {
    let done = false;
    const go = () => { if (!done) { done = true; resolve(); } };
    view.requestAnimationFrame(go);
    view.setTimeout(go, 100);
  });
  // Scrolled into view at every look: an element that moved on is followed to where it went.
  const box = () => {
    this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = this.getBoundingClientRect();
    // In page coordinates, so following it by scrolling never makes it look still.
    return [r.x + view.scrollX, r.y + view.scrollY, r.width, r.height];
  };
  // Where a click would aim: a button pulsing in place holds still, one sliding away does not.
  const same = (a, b) =>
    Math.abs(a[0] + a[2] / 2 - b[0] - b[2] / 2) < 1 && Math.abs(a[1] + a[3] / 2 - b[1] - b[3] / 2) < 1;
  const deadline = view.performance.now() + 1000;
  // Steady across two frames in a row: an animation that just began may not move for one.
  let last = box(), steady = 0;
  while (steady < 2) {
    await frame();
    const now = box();
    steady = same(now, last) ? steady + 1 : 0;
    last = now;
    if (steady < 2 && view.performance.now() > deadline) return { failure: 'moving' };
  }
  const { x, y, width, height } = this.getBoundingClientRect();
  const style = view.getComputedStyle(this);
  if (width <= 0 || height <= 0 || style.visibility === 'hidden') return { failure: 'not_visible' };
  const left = Math.max(x, 0), top = Math.max(y, 0);
  const right = Math.min(x + width, view.innerWidth), bottom = Math.min(y + height, view.innerHeight);
  if (right - left < 1 || bottom - top < 1) return { failure: 'outside' };
  const within = (node, owner) => {
    for (let n = node; n; n = n.parentNode || n.host) if (n === owner) return true;
    return false;
  };
  const hitAt = (px, py) => {
    let hit = doc.elementFromPoint(px, py);
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(px, py);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };
  const labels = this.labels ? [...this.labels] : [];
  const receives = (hit) =>
    within(hit, this) || labels.some((label) => within(hit, label)) ||
    // An element that takes no pointer input lets the click fall to the one around it.
    (style.pointerEvents === 'none' && within(this, hit));
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  const points = [
    [cx, cy],
    [(left + cx) / 2, (top + cy) / 2], [(cx + right) / 2, (top + cy) / 2],
    [(left + cx) / 2, (cy + bottom) / 2], [(cx + right) / 2, (cy + bottom) / 2],
  ];
  let covered = false;
  for (const [px, py] of points) {
    const hit = hitAt(px, py);
    if (hit && receives(hit)) return { x, y, width, height, point: { x: px, y: py } };
    if (hit) covered = true;
  }
  return { failure: covered ? 'covered' : 'outside' };
}`;

const Point = z.object({ x: z.number(), y: z.number() });
export const HitTarget = z.union([
  z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    point: Point,
  }),
  z.object({ failure: z.enum(["moving", "not_visible", "outside", "covered"]) }),
]);

/** The element's box and the point to press, in its document's CSS pixels; or why not. */
export function hitPoint(raw: unknown): {
  rect: { x: number; y: number; width: number; height: number };
  point: { x: number; y: number };
} {
  const hit = HitTarget.parse(raw);
  if ("failure" in hit) {
    if (hit.failure === "not_visible") throw new BrowserActionError("not_visible");
    if (hit.failure === "covered") throw new BrowserActionError("covered");
    throw new BrowserActionError("not_hittable");
  }
  const { point, ...rect } = hit;
  return { rect, point };
}
