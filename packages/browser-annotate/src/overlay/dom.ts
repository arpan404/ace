/**
 * DOM construction without HTML strings: pages with Trusted Types or a strict CSP must still
 * render the overlay, so nothing here assigns markup or a `style` attribute.
 */
export interface Props {
  class?: string;
  text?: string;
  attrs?: Record<string, string>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: Node[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) node.setAttribute(name, value);
  for (const child of children) node.append(child);
  return node;
}

/** Inline CSSOM writes; `important` beats page rules aimed at the host element. */
export function place(
  node: ElementCSSInlineStyle,
  styles: Record<string, string>,
  important = false,
): void {
  for (const [name, value] of Object.entries(styles))
    node.style.setProperty(name, value, important ? "important" : "");
}

export function button(
  className: string,
  label: string,
  children: Node[],
  onPress: () => void,
): HTMLButtonElement {
  const node = h("button", { class: className, attrs: { type: "button", "aria-label": label } });
  node.title = label;
  node.append(...children);
  node.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    event.preventDefault();
    if (!node.disabled) onPress();
  });
  return node;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
