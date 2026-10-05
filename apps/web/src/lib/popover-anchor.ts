interface Rect {
  x: number;
  y: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * A popover anchor that lines up with `trigger` across but sits on top of its closest
 * `container`: a control in the composer's footer opens its popover above the whole composer,
 * so the popover never covers what is being written. Without such a container, the trigger.
 */
export function anchorAbove(
  trigger: Element | null,
  container: string,
): { getBoundingClientRect(): Rect; contextElement: Element } | Element | null {
  const box = trigger?.closest(container);
  if (!trigger || !box) return trigger;
  return {
    contextElement: trigger,
    getBoundingClientRect() {
      const own = trigger.getBoundingClientRect();
      const top = Math.min(own.top, box.getBoundingClientRect().top);
      const height = own.bottom - top;
      return {
        x: own.left,
        y: top,
        top,
        left: own.left,
        right: own.right,
        bottom: own.bottom,
        width: own.width,
        height,
      };
    },
  };
}
