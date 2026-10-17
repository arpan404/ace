import { h, place } from "./dom.ts";

/** The accent box drawn around the element under the pointer or being commented on. */
export function createOutline(parent: HTMLElement) {
  const node = h("div", { class: "outline" });
  parent.append(node);
  return {
    show(element: Element | null): void {
      const rect = element?.isConnected ? element.getBoundingClientRect() : null;
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        node.classList.remove("shown");
        return;
      }
      node.classList.add("shown");
      place(node, {
        translate: `${rect.left - 2}px ${rect.top - 2}px`,
        width: `${rect.width + 4}px`,
        height: `${rect.height + 4}px`,
      });
    },
    conceal(hidden: boolean): void {
      node.classList.toggle("concealed", hidden);
    },
  };
}

/** A short confirmation above the bar, e.g. "Screenshot saved to clipboard". */
export function createToast(parent: HTMLElement, anchor: { top(): number; centre(): number }) {
  let node: HTMLElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    clearTimeout(timer);
    node?.remove();
    node = undefined;
  };
  return {
    show(text: string): void {
      clear();
      const toast = h("div", { class: "toast glass", text, attrs: { role: "status" } });
      parent.append(toast);
      node = toast;
      const left = Math.max(8, anchor.centre() - toast.offsetWidth / 2);
      const top = Math.max(8, anchor.top() - toast.offsetHeight - 10);
      place(toast, { translate: `${left}px ${top}px` });
      timer = setTimeout(clear, 2400);
    },
    conceal(hidden: boolean): void {
      node?.classList.toggle("concealed", hidden);
    },
    dispose: clear,
  };
}
