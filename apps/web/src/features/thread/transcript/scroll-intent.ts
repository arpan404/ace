/** Reader intent cancels jump placement and releases the live end before a scroll event. */
export function listenScrollIntent(
  element: HTMLElement,
  direction: (upward: boolean) => void,
  stopLanding: () => void,
): () => void {
  let touchY: number | undefined;
  let pointerTop: number | undefined;
  const pointerDown = (event: PointerEvent) => {
    stopLanding();
    // Native scrollbar drags target the viewport, and provide only scroll direction.
    if (event.target === element) pointerTop = element.scrollTop;
  };
  const pointerUp = () => {
    pointerTop = undefined;
  };
  const scroll = () => {
    if (pointerTop === undefined) return;
    const moved = element.scrollTop - pointerTop;
    pointerTop = element.scrollTop;
    if (moved) direction(moved < 0);
  };
  const wheel = (event: WheelEvent) => {
    stopLanding();
    if (event.deltaY) direction(event.deltaY < 0);
  };
  const touchStart = (event: TouchEvent) => {
    stopLanding();
    touchY = event.touches[0]?.clientY;
  };
  const touchMove = (event: TouchEvent) => {
    const y = event.touches[0]?.clientY;
    if (y !== undefined && touchY !== undefined && y !== touchY) direction(y > touchY);
    touchY = y;
  };
  const key = (event: KeyboardEvent) => {
    stopLanding();
    if (["ArrowUp", "PageUp", "Home"].includes(event.key)) direction(true);
    if (["ArrowDown", "PageDown", "End"].includes(event.key)) direction(false);
  };
  element.addEventListener("wheel", wheel, { passive: true });
  element.addEventListener("touchstart", touchStart, { passive: true });
  element.addEventListener("touchmove", touchMove, { passive: true });
  element.addEventListener("keydown", key);
  element.addEventListener("pointerdown", pointerDown);
  element.addEventListener("scroll", scroll, { passive: true });
  element.ownerDocument.addEventListener("pointerup", pointerUp);
  element.ownerDocument.addEventListener("pointercancel", pointerUp);
  return () => {
    element.removeEventListener("wheel", wheel);
    element.removeEventListener("touchstart", touchStart);
    element.removeEventListener("touchmove", touchMove);
    element.removeEventListener("keydown", key);
    element.removeEventListener("pointerdown", pointerDown);
    element.removeEventListener("scroll", scroll);
    element.ownerDocument.removeEventListener("pointerup", pointerUp);
    element.ownerDocument.removeEventListener("pointercancel", pointerUp);
  };
}
