import { useEffect } from "react";

/** A card of the conversation by the call id it answers: a question or a request. */
export const requestAnchor = (callId: string) =>
  `[data-question="${CSS.escape(callId)}"], [data-request="${CSS.escape(callId)}"]`;

/**
 * Brings forward the approval or question a notification opened (ADR 0195): once the
 * conversation shows, its card is scrolled to the middle and focused, so its keys answer it. A
 * card already answered is no longer raised; the conversation then just opens.
 */
export function useRevealRequest(callId: string | undefined, shown: boolean): void {
  useEffect(() => {
    if (!callId || !shown) return;
    const frame = requestAnimationFrame(() => {
      const card = document.querySelector<HTMLElement>(requestAnchor(callId));
      card?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      card?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [callId, shown]);
}
