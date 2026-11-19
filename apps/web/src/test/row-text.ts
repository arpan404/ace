/**
 * A row's words as a person reads them: its text without what it hides from assistive tech (a
 * project's initials in Active's project mark, the mark's glyphs).
 */
export function rowText(element: Element): string {
  const copy = element.cloneNode(true);
  if (!(copy instanceof Element)) return "";
  for (const hidden of copy.querySelectorAll("[aria-hidden]")) hidden.remove();
  return copy.textContent ?? "";
}
