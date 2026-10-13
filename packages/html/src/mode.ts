import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import type { HtmlMode } from "@ace/protocol";

type Node = DefaultTreeAdapterMap["node"];

const isHandler = (name: string) => name.toLowerCase().startsWith("on");

/** Visits every element, including template contents, until `visit` returns true. */
function someElement(
  root: Node,
  visit: (element: DefaultTreeAdapterMap["element"]) => boolean,
): boolean {
  const pending: Node[] = [root];
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    if ("childNodes" in node) pending.push(...node.childNodes);
    if (!("tagName" in node)) continue;
    if ("content" in node) pending.push(node.content);
    if (visit(node)) return true;
  }
  return false;
}

/** True when the page has a script element or an inline event handler. */
export function hasScript(html: string): boolean {
  return someElement(
    parse(html),
    (element) => element.tagName === "script" || element.attrs.some((attr) => isHandler(attr.name)),
  );
}

/** The agent's choice when it made one; otherwise `static` for a page with no script. */
export function resolveHtmlMode(html: string, mode: HtmlMode | undefined): HtmlMode {
  return mode ?? (hasScript(html) ? "interactive" : "static");
}

/** The page with every script element and inline event handler removed. */
export function withoutScripts(html: string): string {
  const document = parse(html);
  const pending: Node[] = [document];
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    if ("childNodes" in node) {
      node.childNodes = node.childNodes.filter(
        (child) => !("tagName" in child && child.tagName === "script"),
      );
      pending.push(...node.childNodes);
    }
    if (!("tagName" in node)) continue;
    if ("content" in node) pending.push(node.content);
    node.attrs = node.attrs.filter((attr) => !isHandler(attr.name));
  }
  return serialize(document);
}
