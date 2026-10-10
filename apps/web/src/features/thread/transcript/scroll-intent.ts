/** Reader intent cancels jump placement and releases the live end before a scroll event. */
export function listenScrollIntent(
  element: HTMLElement,
  direction: (upward: boolean) => void,
  stopLanding: () => void,
): () => void {
  let touchY: number | undefined;
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
  element.addEventListener("pointerdown", stopLanding);
  return () => {
    element.removeEventListener("wheel", wheel);
    element.removeEventListener("touchstart", touchStart);
    element.removeEventListener("touchmove", touchMove);
    element.removeEventListener("keydown", key);
    element.removeEventListener("pointerdown", stopLanding);
  };
}
