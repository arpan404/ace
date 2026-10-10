/** A mounted card keeps one pending restoration, cancelled by an actual user gesture. */
export function attachCardScroll(
  node: HTMLDivElement,
  saved: number,
  save: (position: number) => void,
) {
  let pending = saved > 0;
  let latest = node.scrollTop;
  let written = saved;
  const restore = () => {
    if (!pending || node.scrollHeight - node.clientHeight < saved) return;
    node.scrollTop = saved;
    latest = node.scrollTop;
    pending = false;
  };
  const record = () => {
    if (!pending) latest = node.scrollTop;
  };
  const gesture = () => {
    pending = false;
  };
  const persist = () => {
    if (pending || latest === written) return;
    written = latest;
    save(latest);
  };
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(restore);
  const content = node.firstElementChild;
  if (content) observer?.observe(content);
  observer?.observe(node);
  node.addEventListener("scroll", record, { passive: true });
  node.addEventListener("scrollend", persist);
  node.addEventListener("wheel", gesture, { passive: true });
  node.addEventListener("pointerdown", gesture);
  node.addEventListener("keydown", gesture);
  restore();
  return () => {
    record();
    observer?.disconnect();
    node.removeEventListener("scroll", record);
    node.removeEventListener("scrollend", persist);
    node.removeEventListener("wheel", gesture);
    node.removeEventListener("pointerdown", gesture);
    node.removeEventListener("keydown", gesture);
    persist();
  };
}
