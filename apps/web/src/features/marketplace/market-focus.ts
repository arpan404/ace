/*
 * Keeps Tab inside the Marketplace modal: it is a modal dialog over the app, so focus wraps from
 * its last control to its first (and back with Shift-Tab) instead of walking into the app behind.
 */

const tabbable = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]",
]
  .map((selector) => `${selector}:not([tabindex="-1"])`)
  .join(",");

/** The controls Tab reaches inside `within`, leaving out hidden and leaving layers. */
function tabbableIn(within: HTMLElement): HTMLElement[] {
  return [...within.querySelectorAll<HTMLElement>(tabbable)].filter(
    (element) => !element.closest('[inert], [hidden], [aria-hidden="true"]'),
  );
}

/** Wraps a Tab press at either end of `within`, and pulls focus back in if it got out. */
export function keepTabWithin(within: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
  const items = tabbableIn(within);
  const first = items[0];
  const last = items.at(-1);
  const active = document.activeElement;
  if (!first || !last) {
    event.preventDefault();
    within.focus();
    return;
  }
  const inside = active instanceof Node && within.contains(active);
  if (!inside || (event.shiftKey ? active === first || active === within : active === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}
