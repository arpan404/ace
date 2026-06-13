import { createElement, type CSSProperties, type ReactNode } from "react";

const ALLOWED_HIGHLIGHT_TAGS = new Set(["br", "code", "pre", "span"]);
const ALLOWED_STYLE_PROPERTIES = [
  "backgroundColor",
  "color",
  "display",
  "fontStyle",
  "fontWeight",
  "textDecoration",
] as const;

function readAllowedStyle(element: HTMLElement): CSSProperties | undefined {
  const style: CSSProperties = {};
  for (const property of ALLOWED_STYLE_PROPERTIES) {
    const value = element.style[property];
    if (value) {
      style[property] = value;
    }
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

function renderNode(node: ChildNode, key: string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const element = node as HTMLElement;
  const tagName = element.tagName.toLowerCase();
  if (tagName === "script" || tagName === "style") {
    return null;
  }

  const children = Array.from(element.childNodes, (childNode, index) =>
    renderNode(childNode, `${key}.${index}`),
  );
  if (!ALLOWED_HIGHLIGHT_TAGS.has(tagName)) {
    return children;
  }
  if (tagName === "br") {
    return createElement("br", { key });
  }

  return createElement(
    tagName,
    {
      key,
      className: element.className || undefined,
      style: readAllowedStyle(element),
    },
    children,
  );
}

export function renderTrustedHighlightedHtml(html: string): ReactNode {
  if (typeof document === "undefined") {
    return html;
  }

  const template = document.createElement("template");
  template.innerHTML = html;
  return Array.from(template.content.childNodes, (node, index) => renderNode(node, `${index}`));
}
