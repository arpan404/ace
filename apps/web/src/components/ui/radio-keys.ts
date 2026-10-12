import type { KeyboardEvent } from "react";

/**
 * Arrow keys for a radio group of buttons: one Tab stop (the checked one), ←/→ and ↑/↓ move
 * and choose, Home/End jump to the ends. Spread on the element with `role="radiogroup"`.
 */
export function onRadioKeys(event: KeyboardEvent<HTMLElement>) {
  const radios = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not([disabled])'),
  ];
  const current = radios.indexOf(document.activeElement as HTMLElement);
  if (current === -1) return;
  const last = radios.length - 1;
  const next =
    event.key === "ArrowRight" || event.key === "ArrowDown"
      ? current === last
        ? 0
        : current + 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? current === 0
          ? last
          : current - 1
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : undefined;
  if (next === undefined) return;
  event.preventDefault();
  const target = radios[next];
  target?.focus();
  // A colour input opens its picker on click; it's chosen with Enter or Space instead.
  if (target && !(target instanceof HTMLInputElement)) target.click();
}
