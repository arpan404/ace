import { afterEach, beforeEach } from "vitest";

/*
 * jsdom loads no CSS and lays nothing out, so a long list (`VirtualList`) finds no scrolling
 * ancestor and mounts nothing. For a test of such a list: an element with the `overflow-y-auto`
 * class scrolls and is `viewport` px tall, every other element is `row` px, and scrolling it
 * scrolls, as a browser would.
 */
const scrolls = (element: Element) => element.classList.contains("overflow-y-auto");

export function useScrollLayout(options: { viewport: number; row: number }): void {
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const content = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
  const computed = window.getComputedStyle;
  const scrollTo = Element.prototype.scrollTo;
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return scrolls(this) ? options.viewport : options.row;
      },
    });
    // Room to scroll anywhere: the virtualizer clamps where it scrolls to by this.
    Object.defineProperty(Element.prototype, "scrollHeight", {
      configurable: true,
      get(this: Element) {
        return scrolls(this) ? 10_000_000 : 0;
      },
    });
    window.getComputedStyle = (element, pseudo) => {
      const style = computed(element, pseudo);
      if (!scrolls(element)) return style;
      return new Proxy(style, {
        get: (target, key) =>
          key === "overflowY" ? "auto" : (Reflect.get(target, key, target) as unknown),
      });
    };
    Element.prototype.scrollTo = function (this: Element, ...args: unknown[]) {
      const [first] = args;
      const top = typeof first === "object" && first ? (first as ScrollToOptions).top : undefined;
      if (top === undefined) return;
      this.scrollTop = top;
      this.dispatchEvent(new Event("scroll"));
    } as typeof Element.prototype.scrollTo;
  });
  afterEach(() => {
    if (height) Object.defineProperty(HTMLElement.prototype, "offsetHeight", height);
    if (content) Object.defineProperty(Element.prototype, "scrollHeight", content);
    window.getComputedStyle = computed;
    Element.prototype.scrollTo = scrollTo;
  });
}
