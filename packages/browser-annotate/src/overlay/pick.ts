import { cssSelector, xpath } from "./selector.ts";
import type { OverlayElement } from "./types.ts";

/** The page element under a viewport point, never the overlay itself. */
export function elementAt(x: number, y: number, host: Element): Element | null {
  for (const element of document.elementsFromPoint(x, y)) {
    if (element === host || host.contains(element)) continue;
    return frameAt(x, y, element) ?? element;
  }
  return null;
}

/**
 * Embedded frames ignore the pointer while annotating (see intercept), so hit testing passes
 * through them to their container. The last frame inside that container under the point is the
 * one drawn on top.
 */
function frameAt(x: number, y: number, container: Element): Element | undefined {
  let found: Element | undefined;
  for (const frame of container.querySelectorAll("iframe, frame, embed, object")) {
    const box = frame.getBoundingClientRect();
    if (x >= box.left && x < box.right && y >= box.top && y < box.bottom) found = frame;
  }
  return found;
}

const implicitRoles: Record<string, string> = {
  button: "button",
  select: "combobox",
  textarea: "textbox",
  img: "img",
  nav: "navigation",
  main: "main",
  header: "banner",
  footer: "contentinfo",
  aside: "complementary",
  ul: "list",
  ol: "list",
  li: "listitem",
  table: "table",
  form: "form",
  dialog: "dialog",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
};
const inputRoles: Record<string, string> = {
  button: "button",
  submit: "button",
  reset: "button",
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
};

function collapse(text: string, limit: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

function role(element: Element): string | undefined {
  const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit) return explicit.slice(0, 128);
  if (element instanceof HTMLAnchorElement)
    return element.hasAttribute("href") ? "link" : undefined;
  if (element instanceof HTMLInputElement) return inputRoles[element.type] ?? "textbox";
  return implicitRoles[element.localName];
}

/** Text the person sees; a password field's value is never read. */
function visibleText(element: Element): string {
  if (element instanceof HTMLInputElement)
    return element.type === "password" ? "" : collapse(element.value, 280);
  if (element instanceof HTMLTextAreaElement) return collapse(element.value, 280);
  if (element instanceof HTMLSelectElement)
    return collapse(element.selectedOptions[0]?.textContent ?? "", 280);
  const raw = element instanceof HTMLElement ? element.innerText : (element.textContent ?? "");
  return collapse(raw.slice(0, 4096), 280);
}

function accessibleName(element: Element): string | undefined {
  const label = element.getAttribute("aria-label");
  if (label?.trim()) return collapse(label, 256);
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (text.trim()) return collapse(text, 256);
  }
  if (element instanceof HTMLImageElement && element.alt) return collapse(element.alt, 256);
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    const text = element.labels?.[0]?.textContent;
    if (text?.trim()) return collapse(text, 256);
    if ("placeholder" in element && element.placeholder) return collapse(element.placeholder, 256);
  }
  const title = element.getAttribute("title");
  if (title?.trim()) return collapse(title, 256);
  if (element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement)
    return collapse(element.innerText, 256) || undefined;
  return undefined;
}

export function describeElement(element: Element): OverlayElement {
  const rect = element.getBoundingClientRect();
  const name = accessibleName(element);
  const kind = role(element);
  return {
    tag: element.localName.slice(0, 64),
    selector: cssSelector(element).slice(0, 2048),
    xpath: xpath(element).slice(0, 2048),
    text: visibleText(element),
    ...(kind ? { role: kind } : {}),
    ...(name ? { name } : {}),
    box: {
      x: Math.round(rect.left + scrollX),
      y: Math.round(rect.top + scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

function fraction(offset: number, size: number): number {
  return size > 0 ? Math.min(1, Math.max(0, offset / size)) : 0.5;
}

/** Where a click fell inside the element, as fractions of its box. */
export function pointIn(element: Element, x: number, y: number): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: fraction(x - rect.left, rect.width), y: fraction(y - rect.top, rect.height) };
}
