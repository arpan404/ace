import type { z } from "zod";
import type { AXTree } from "./cdp.ts";

type AXNode = z.infer<typeof AXTree>["nodes"][number];

/** One meaningful accessibility node, in document order with its depth among kept nodes. */
export interface CompactNode {
  ref?: string | undefined;
  role: string;
  name: string;
  value?: string | undefined;
  states?: string[] | undefined;
  depth: number;
  frameId?: string | undefined;
}

/** Roles an agent can act on; these always get a line and a ref. */
const interactiveRoles = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
  "colorwell",
  "popupbutton",
  "togglebutton",
  "disclosuretriangle",
]);
/** Structure worth a line even without a name: it tells the agent where things are. */
const structuralRoles = new Set([
  "heading",
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "search",
  "form",
  "dialog",
  "alertdialog",
  "alert",
  "status",
  "list",
  "listitem",
  "table",
  "row",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "grid",
  "tablist",
  "tabpanel",
  "menu",
  "menubar",
  "toolbar",
  "tree",
  "article",
  "iframe",
]);
/** Wrappers that only add depth. Their children are lifted to the nearest kept ancestor. */
const transparentRoles = new Set([
  "generic",
  "none",
  "presentation",
  "rootwebarea",
  "webarea",
  "paragraph",
  "labeltext",
  "inlinetextbox",
  "linebreak",
  "section",
  "div",
  "span",
  "ignored",
]);
const textRoles = new Set(["statictext", "text"]);
/** Decoration with no meaning for an agent; dropped with everything beneath it. */
const droppedRoles = new Set(["listmarker", "scrollbar"]);
const maxName = 200;
const maxText = 300;

function clip(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}
function text(raw: { value?: unknown } | undefined): string {
  const value = raw?.value;
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function states(node: AXNode, role: string): string[] {
  const out: string[] = [];
  for (const property of node.properties ?? []) {
    const value = property.value?.value;
    switch (property.name) {
      case "focused":
      case "disabled":
      case "selected":
      case "required":
      case "pressed":
        if (value === true || value === "true") out.push(property.name);
        break;
      case "readonly":
        if ((value === true || value === "true") && interactiveRoles.has(role))
          out.push("readonly");
        break;
      case "checked":
        if (value === "true" || value === true) out.push("checked");
        else if (value === "mixed") out.push("mixed");
        break;
      case "expanded":
        if (value === true || value === "true") out.push("expanded");
        else if (value === false || value === "false") out.push("collapsed");
        break;
      case "invalid":
        if (value !== undefined && value !== false && value !== "false") out.push("invalid");
        break;
      case "level":
        if (role === "heading" && typeof value === "number") out.push(`level=${value}`);
        break;
    }
  }
  return out;
}

interface Kept {
  node: CompactNode;
  children: Kept[];
}

export interface CompactOptions {
  /** Builds the ref for a DOM-backed node; text nodes never get one. */
  refOf(backendNodeId: number): string;
  /** Start from this node (by backend DOM id) instead of the document root. */
  scope?: number;
  interactiveOnly?: boolean;
  frameId?: string | undefined;
}

/**
 * Turns a raw CDP accessibility tree into the lines an agent needs: ignored nodes and wrappers
 * vanish, text that only repeats its parent's name is dropped, and an unnamed node whose only
 * child is text takes that text as its name. Returns undefined when `scope` is not in the tree.
 */
export function compactTree(nodes: AXNode[], options: CompactOptions): CompactNode[] | undefined {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  let roots: AXNode[];
  if (options.scope !== undefined) {
    const scoped = nodes.find((node) => node.backendDOMNodeId === options.scope);
    if (!scoped) return undefined;
    roots = [scoped];
  } else {
    const children = new Set(nodes.flatMap((node) => node.childIds ?? []));
    roots = nodes.filter((node) => !children.has(node.nodeId));
  }
  const visited = new Set<string>();
  const top: Kept[] = [];
  // Iterative walk: deep component trees must not overflow the stack.
  const stack: { node: AXNode; parent: Kept | undefined; inherited: string }[] = roots
    .toReversed()
    .map((node) => ({ node, parent: undefined, inherited: "" }));
  while (stack.length) {
    const entry = stack.pop();
    if (!entry || visited.has(entry.node.nodeId)) continue;
    visited.add(entry.node.nodeId);
    const { node, parent, inherited } = entry;
    if (droppedRoles.has(text(node.role).toLowerCase())) continue;
    const kept = keep(node, inherited, options);
    if (kept) (parent ? parent.children : top).push(kept);
    const nextParent = kept ?? parent;
    // Text that repeats its element's name or value (a field's own contents) adds nothing.
    const nextName = kept ? `${kept.node.name}\n${kept.node.value ?? ""}` : inherited;
    const children = (node.childIds ?? []).flatMap((id) => byId.get(id) ?? []);
    for (const child of children.toReversed())
      stack.push({ node: child, parent: nextParent, inherited: nextName });
  }
  const out: CompactNode[] = [];
  const flatten = (list: Kept[], depth: number) => {
    for (const item of list) {
      fold(item);
      out.push({ ...item.node, depth: options.interactiveOnly ? 0 : depth });
      flatten(item.children, depth + 1);
    }
  };
  flatten(top, 0);
  return out;
}

function keep(node: AXNode, inherited: string, options: CompactOptions): Kept | undefined {
  if (node.ignored) return undefined;
  const raw = text(node.role);
  const role = raw.toLowerCase();
  if (transparentRoles.has(role)) return undefined;
  const isText = textRoles.has(role);
  const name = clip(text(node.name), isText ? maxText : maxName);
  if (isText) {
    if (options.interactiveOnly || !name || inherited.includes(name)) return undefined;
    return { node: { role: "text", name, depth: 0 }, children: [] };
  }
  const interactive = interactiveRoles.has(role);
  if (options.interactiveOnly && !interactive) return undefined;
  if (!interactive && !structuralRoles.has(role) && !name) return undefined;
  const output: CompactNode = { role: raw === "image" ? "img" : raw, name, depth: 0 };
  const value = clip(text(node.value), maxName);
  if (value && value !== name) output.value = value;
  const flags = states(node, role);
  if (flags.length) output.states = flags;
  if (node.backendDOMNodeId) output.ref = options.refOf(node.backendDOMNodeId);
  if (options.frameId) output.frameId = options.frameId;
  return { node: output, children: [] };
}

/** `- listitem` + `- text: Milk` reads better as `- listitem: Milk`. */
function fold(item: Kept): void {
  const only = item.children.length === 1 ? item.children[0] : undefined;
  if (!item.node.name && only?.node.role === "text" && !only.children.length) {
    item.node.name = only.node.name;
    item.children = [];
  }
}
