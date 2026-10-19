import { isEditable } from "@/lib/hotkeys.ts";

/**
 * Whether a blank tab's address takes focus as the tab opens. A tab the person opened starts at
 * its address, as in any browser. A tab an agent opened never takes focus, and no opening tab
 * takes it from a field the person is typing in outside the panel (the composer).
 */
export function addressTakesFocus(input: {
  openedByAgent: boolean;
  /** `document.activeElement` as the tab opens. */
  active: Element | null;
  /** The side panel the tab opens in. */
  panel: Element | null;
}): boolean {
  if (input.openedByAgent) return false;
  const { active, panel } = input;
  if (!active || active === active.ownerDocument.body) return true;
  if (panel?.contains(active)) return true;
  return !isEditable(active);
}
