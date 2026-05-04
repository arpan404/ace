export function buildBrowserDomSnapshotScript(): string {
  return `(() => {
  const MAX_ELEMENTS = 120;
  const MAX_TEXT = 120;
  const escapeCss = (value) => {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
  };
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0;
  };
  const textFor = (element) => (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, MAX_TEXT);
  const selectorFor = (element) => {
    if (element.id) return "#" + escapeCss(element.id);
    const testId = element.getAttribute("data-testid");
    if (testId) return "[data-testid=\\"" + escapeCss(testId) + "\\"]";
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && current !== document.body && parts.length < 4) {
      let part = current.tagName.toLowerCase();
      if (current.classList.length > 0) {
        part += "." + Array.from(current.classList).slice(0, 2).map(escapeCss).join(".");
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(" > ") || element.tagName.toLowerCase();
  };
  const targets = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role='button'],[role='link'],[tabindex],summary"))
    .filter(isVisible)
    .slice(0, MAX_ELEMENTS)
    .map((element, index) => {
      const rect = element.getBoundingClientRect();
      return {
        index,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        label: element.getAttribute("aria-label") || element.getAttribute("title") || textFor(element),
        selector: selectorFor(element),
        href: element instanceof HTMLAnchorElement ? element.href : null,
        value: "value" in element ? String(element.value || "") : null,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
    });
  return {
    title: document.title,
    url: location.href,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    elements: targets,
  };
})()`;
}

export function buildBrowserClickScript(selector: string): string {
  return `(() => {
  const selector = ${JSON.stringify(selector)};
  const element = document.querySelector(selector);
  if (!element) throw new Error("No element matched selector: " + selector);
  element.scrollIntoView({ block: "center", inline: "center" });
  if (typeof element.click !== "function") throw new Error("Matched element cannot be clicked.");
  element.click();
  return {
    clicked: true,
    selector,
    tag: element.tagName.toLowerCase(),
    text: (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 160),
  };
})()`;
}

export function buildBrowserFillScript(selector: string, value: string): string {
  return `(() => {
  const selector = ${JSON.stringify(selector)};
  const value = ${JSON.stringify(value)};
  const element = document.querySelector(selector);
  if (!element) throw new Error("No element matched selector: " + selector);
  element.scrollIntoView({ block: "center", inline: "center" });
  if (!("value" in element)) throw new Error("Matched element cannot be filled.");
  element.focus?.();
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : null;
  const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, "value")?.set : null;
  if (setter) {
    setter.call(element, value);
  } else {
    element.value = value;
  }
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return {
    filled: true,
    selector,
    tag: element.tagName.toLowerCase(),
    value,
  };
})()`;
}
