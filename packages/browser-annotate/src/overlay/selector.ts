/**
 * Locators an agent can search source and tests for. The CSS selector prefers what authors
 * write (ids, test ids, labels, readable classes) and is always verified unique in the
 * document; the XPath is absolute and positional.
 */
const testAttributes = ["data-testid", "data-test", "data-test-id", "data-cy"];

function unique(selector: string, element: Element): boolean {
  try {
    const matches = element.ownerDocument.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === element;
  } catch {
    return false;
  }
}

function quoted(value: string): string {
  return `"${value.replace(/["\\]/g, "\\$&").replace(/\n/g, "\\a ")}"`;
}

function tagOf(element: Element): string {
  const tag = CSS.escape(element.localName);
  return element.namespaceURI === "http://www.w3.org/1999/xhtml" ? tag : `*|${tag}`;
}

/** Generated class names (hashes, CSS-in-JS) change between builds and say nothing. */
function readableClass(name: string): boolean {
  return (
    /^[a-zA-Z][\w-]{0,39}$/.test(name) &&
    !/\d{3,}/.test(name) &&
    !/^(css|sc|jsx|emotion|svelte)-/.test(name) &&
    !/__[\w]{5,}$/.test(name)
  );
}

function step(element: Element): string {
  const classes = [...element.classList].filter(readableClass).slice(0, 2);
  const base = tagOf(element) + classes.map((name) => `.${CSS.escape(name)}`).join("");
  const parent = element.parentElement;
  if (!parent) return base;
  const twins = [...parent.children].filter(
    (sibling) =>
      sibling.localName === element.localName &&
      classes.every((name) => sibling.classList.contains(name)),
  );
  if (twins.length <= 1) return base;
  const sameTag = [...parent.children].filter((sibling) => sibling.localName === element.localName);
  return `${base}:nth-of-type(${sameTag.indexOf(element) + 1})`;
}

function strictPath(element: Element): string {
  const steps: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const parent: Element | null = node.parentElement;
    if (!parent) {
      steps.unshift(tagOf(node));
      break;
    }
    const sameTag = [...parent.children].filter((sibling) => sibling.localName === node?.localName);
    steps.unshift(`${tagOf(node)}:nth-of-type(${sameTag.indexOf(node) + 1})`);
  }
  return steps.join(" > ");
}

export function cssSelector(element: Element): string {
  const tag = tagOf(element);
  if (element.id) {
    const selector = `#${CSS.escape(element.id)}`;
    if (unique(selector, element)) return selector;
  }
  for (const name of testAttributes) {
    const value = element.getAttribute(name);
    if (!value) continue;
    const selector = `[${name}=${quoted(value)}]`;
    if (unique(selector, element)) return selector;
  }
  const label = element.getAttribute("aria-label");
  if (label) {
    const selector = `${tag}[aria-label=${quoted(label)}]`;
    if (unique(selector, element)) return selector;
  }
  const steps: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node !== element && node.id && unique(`#${CSS.escape(node.id)}`, node)) {
      steps.unshift(`#${CSS.escape(node.id)}`);
      const anchored = steps.join(" > ");
      if (unique(anchored, element)) return anchored;
      break;
    }
    steps.unshift(step(node));
    const selector = steps.join(" > ");
    if (unique(selector, element)) return selector;
  }
  return strictPath(element);
}

export function xpath(element: Element): string {
  const parts: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const name = node.localName;
    const html = node.namespaceURI === "http://www.w3.org/1999/xhtml";
    const test = html ? name : `*[local-name()="${name}"]`;
    const parent: Element | null = node.parentElement;
    const twins = parent
      ? [...parent.children].filter((sibling) => sibling.localName === name)
      : [];
    parts.unshift(twins.length > 1 ? `${test}[${twins.indexOf(node) + 1}]` : test);
  }
  return `/${parts.join("/")}`;
}

/** Find a recorded element again: selector first, then XPath. */
export function resolveElement(selector: string, path: string): Element | null {
  try {
    const found = document.querySelector(selector);
    if (found) return found;
  } catch {
    /* A selector from another document may not parse here. */
  }
  try {
    const result = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE);
    return result.singleNodeValue instanceof Element ? result.singleNodeValue : null;
  } catch {
    return null;
  }
}

/** The part of an element its scrolling and clipping ancestors leave visible, in viewport px. */
export function visibleBox(element: Element): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const box = element.getBoundingClientRect();
  let left = box.left;
  let top = box.top;
  let right = box.right;
  let bottom = box.bottom;
  for (
    let node = element.parentElement;
    node && node !== document.documentElement;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const clip = node.getBoundingClientRect();
    if (style.overflowX !== "visible") {
      left = Math.max(left, clip.left);
      right = Math.min(right, clip.right);
    }
    if (style.overflowY !== "visible") {
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
    }
  }
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}
