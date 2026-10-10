/** Run before paint, or on a timer while hidden. A visibility change also releases a queued frame. */
export function nextFrame(callback: () => void): () => void {
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const doc = globalThis.document;
  const cancel = () => {
    finished = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (timer !== undefined) clearTimeout(timer);
    doc?.removeEventListener("visibilitychange", hidden);
  };
  const run = () => {
    if (finished) return;
    cancel();
    callback();
  };
  const hidden = () => {
    if (doc?.hidden && timer === undefined) timer = setTimeout(run, 100);
  };
  if (typeof requestAnimationFrame === "function" && !doc?.hidden) {
    frame = requestAnimationFrame(run);
    doc?.addEventListener("visibilitychange", hidden);
  } else timer = setTimeout(run, doc?.hidden ? 100 : 16);
  return cancel;
}
