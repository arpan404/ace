import { useEffect } from "react";
import { useStartupHandoff } from "./startup/startup.tsx";

/** Longer than the fade (--motion-base), for when no transition runs (reduced motion, hidden tab). */
const removeAfterMs = 400;

/**
 * Fades out the static first paint `index.html` draws before the app's script runs (the ace
 * mark on the theme's background), then removes it. Safe to call more than once, and a no-op
 * where there is none (tests, or once the startup screen has replaced it).
 */
export function dismissBootSplash(doc: Document): void {
  const splash = doc.getElementById("boot");
  if (!splash || splash.hasAttribute("data-leaving")) return;
  splash.setAttribute("data-leaving", "");
  const remove = () => splash.remove();
  splash.addEventListener("transitionend", remove, { once: true });
  doc.defaultView?.setTimeout(remove, removeAfterMs);
}

/** Remove the static first paint at once: the startup screen drawn over it looks the same. */
export function removeBootSplash(doc: Document): void {
  doc.getElementById("boot")?.remove();
}

/**
 * A screen that takes over from startup (the connection form, a boot failure): the startup
 * screen and the static first paint get out of its way after its first paint.
 */
export function useDismissBootSplash(): void {
  useStartupHandoff();
  useEffect(() => {
    // The frame after commit: the screen underneath has painted, so the fade reveals it.
    const frame = requestAnimationFrame(() => dismissBootSplash(document));
    return () => cancelAnimationFrame(frame);
  }, []);
}
