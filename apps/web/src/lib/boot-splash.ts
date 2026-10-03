import { useEffect } from "react";

/** Longer than the fade (--dur-2), for when no transition runs (reduced motion, hidden tab). */
const removeAfterMs = 400;

/**
 * Fades out the static boot shell `index.html` paints before the app's script runs, then
 * removes it. Call once the real shell (or the connection screen) has painted. Safe to call
 * more than once, and a no-op where there is no boot shell (tests, Electron reloads).
 */
export function dismissBootSplash(doc: Document): void {
  const splash = doc.getElementById("boot");
  if (!splash || splash.hasAttribute("data-leaving")) return;
  splash.setAttribute("data-leaving", "");
  const remove = () => splash.remove();
  splash.addEventListener("transitionend", remove, { once: true });
  doc.defaultView?.setTimeout(remove, removeAfterMs);
}

/** Dismiss the boot shell after this component's first paint. */
export function useDismissBootSplash(): void {
  useEffect(() => {
    // The frame after commit: the shell underneath has painted, so the fade reveals it.
    const frame = requestAnimationFrame(() => dismissBootSplash(document));
    return () => cancelAnimationFrame(frame);
  }, []);
}
