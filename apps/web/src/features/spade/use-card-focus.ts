import { useEffect, type RefObject } from "react";

const control =
  '[role="radio"]:not([disabled]), [role="checkbox"]:not([aria-disabled="true"]), input:not([disabled]), textarea:not([disabled]), [contenteditable="true"]';

/** Whether the person is in the middle of typing: a field with words in it holds focus. */
function typing(active: Element | null): boolean {
  if (!(active instanceof HTMLElement)) return false;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
    return active.value.trim() !== "";
  return active.isContentEditable && (active.textContent ?? "").trim() !== "";
}

/** The composer of the conversation this card is in. */
function composerOf(column: Element | null): HTMLElement | null {
  return (
    column?.querySelector<HTMLElement>(
      '[data-composer-area] [data-part="composer-input"] [role]',
    ) ?? null
  );
}

/**
 * An open card (questions, or a request) takes focus, so its keys are its own and not typed into
 * the composer: its first control on opening and on every question it turns to, unless the
 * person is partway through a message. When it closes with focus gone (the button they pressed
 * left with it), focus goes back to the composer to write in.
 */
export function useCardFocus(card: RefObject<HTMLElement | null>, page: number): void {
  useEffect(() => {
    const element = card.current;
    if (!element) return;
    const active = document.activeElement;
    if (typing(active) && !element.contains(active)) return;
    const first = element.querySelector<HTMLElement>(control);
    (first ?? element).focus({ preventScroll: true });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `page` asks again.
  }, [card, page]);
  useEffect(() => {
    const column = card.current?.closest("[data-thread-column]") ?? null;
    return () => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      composerOf(column)?.focus({ preventScroll: true });
    };
  }, [card]);
}
