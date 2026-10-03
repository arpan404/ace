import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ScreenUITreeOptions,
  ScreenUITreeResult,
  ScreenUIFindOptions,
  ScreenUIFindResult,
  type ScreenUINode,
} from "@ace/protocol";
import { DeviceError } from "./sdk.ts";
type Node = z.infer<typeof ScreenUINode>;
const Attribute = z.record(z.string(), z.string().max(8192));
const Bounds = z.string().regex(/^\[\d+,\d+\]\[\d+,\d+\]$/);
function decode(value: string): string {
  return value.replace(/&(?:quot|apos|amp|lt|gt|#\d+|#x[0-9a-fA-F]+);/g, (entity) => {
    const names: Record<string, string> = {
      "&quot;": '"',
      "&apos;": "'",
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
    };
    if (names[entity] !== undefined) return names[entity];
    const code = entity.startsWith("&#x")
      ? Number.parseInt(entity.slice(3, -1), 16)
      : Number(entity.slice(2, -1));
    if (
      !Number.isInteger(code) ||
      code < 0 ||
      code > 0x10ffff ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      throw new DeviceError(
        "invalid_data",
        "Invalid Android UI entity",
        "Refresh the device tree.",
      );
    return String.fromCodePoint(code);
  });
}
function attributes(tag: string): Record<string, string> {
  const values: Record<string, string> = {};
  const source = tag.replace(/^<node\b/, "").replace(/\/?\s*>$/, "");
  const pattern = /\s+([a-zA-Z_][a-zA-Z0-9_.:-]*)\s*=\s*"([^"<]*)"/gy;
  let cursor = 0;
  while (cursor < source.length) {
    if (!source.slice(cursor).trim()) break;
    pattern.lastIndex = cursor;
    const match = pattern.exec(source);
    if (
      !match ||
      match[1] === undefined ||
      match[2] === undefined ||
      Object.hasOwn(values, match[1])
    )
      throw new DeviceError(
        "invalid_data",
        "Malformed Android UI attributes",
        "Refresh the device tree.",
      );
    values[match[1]] = decode(match[2]);
    cursor = pattern.lastIndex;
  }
  return Attribute.parse(values);
}
function mapped(values: Record<string, string>, path: string): Node {
  const coordinates = Bounds.parse(values["bounds"]).match(/\d+/g)?.map(Number);
  const [x, y, right, bottom] = z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .parse(coordinates);
  if (right < x || bottom < y)
    throw new DeviceError("invalid_data", "Invalid Android UI bounds", "Refresh the device tree.");
  const role = (values["class"] ?? "node").slice(0, 128);
  const text = values["text"] ?? "";
  const name = values["content-desc"] || text || values["resource-id"] || "";
  const states: Node["states"] = [];
  for (const key of ["focused", "selected", "checked"] as const)
    if (values[key] === "true") states.push(key);
  if (values["enabled"] === "false") states.push("disabled");
  const actions: Node["actions"] = [];
  if (!states.includes("disabled")) {
    if (values["clickable"] === "true") actions.push("press");
    if (values["focusable"] === "true") actions.push("focus");
    if (values["scrollable"] === "true") actions.push("scroll");
    if (values["checkable"] === "true") actions.push("select");
  }
  // Ref identifies the observed node and its position. Refreshes with changed
  // resource, text, package, or geometry invalidate an earlier action target.
  const identity = [
    path,
    values["package"],
    values["resource-id"],
    values["class"],
    name,
    text,
    values["bounds"],
    values["enabled"],
  ];
  const ref = `a_${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 40)}`;
  return {
    ref,
    role,
    name: name.slice(0, 256),
    value: text.slice(0, 512),
    bounds: { x, y, w: right - x, h: bottom - y },
    states,
    actions,
    children: [],
  };
}
/** A bounded parser for uiautomator's node-only XML. DTDs/entities are rejected. */
export function androidTree(xml: string, options: unknown): ScreenUITreeResult {
  const limits = ScreenUITreeOptions.parse(options);
  if (Buffer.byteLength(xml) > 1024 * 1024 || /<!/.test(xml))
    throw new DeviceError(
      "limit",
      "Android UI dump exceeds the XML budget",
      "Reduce the app's UI tree.",
    );
  const nodes: Node[] = [];
  const stack: { node: Node | undefined; next: number; path: string }[] = [];
  let count = 0;
  let truncated = false;
  let opened = false;
  let closed = false;
  let cursor = 0;
  const tokens = /<\?xml[^>]*\?>|<hierarchy\b[^>]*>|<\/hierarchy\s*>|<node\b[^>]*>|<\/node\s*>/g;
  for (const match of xml.matchAll(tokens)) {
    if (xml.slice(cursor, match.index).trim())
      throw new DeviceError("invalid_data", "Malformed Android UI XML", "Refresh the device tree.");
    cursor = match.index + match[0].length;
    const tag = match[0];
    if (tag.startsWith("<?xml")) {
      if (opened)
        throw new DeviceError(
          "invalid_data",
          "Unexpected XML declaration",
          "Refresh the device tree.",
        );
      continue;
    }
    if (tag.startsWith("<hierarchy")) {
      if (opened || closed)
        throw new DeviceError("invalid_data", "Duplicate UI hierarchy", "Refresh the device tree.");
      opened = true;
      continue;
    }
    if (tag.startsWith("</hierarchy")) {
      if (!opened || stack.length)
        throw new DeviceError(
          "invalid_data",
          "Unclosed Android UI node",
          "Refresh the device tree.",
        );
      closed = true;
      continue;
    }
    if (!opened || closed)
      throw new DeviceError(
        "invalid_data",
        "UI node outside hierarchy",
        "Refresh the device tree.",
      );
    if (tag.startsWith("</node")) {
      if (!stack.pop())
        throw new DeviceError(
          "invalid_data",
          "Unbalanced Android UI tree",
          "Refresh the device tree.",
        );
      continue;
    }
    if (stack.length > 128 || ++count > 32768)
      throw new DeviceError(
        "limit",
        "Android UI nesting exceeds the parser budget",
        "Reduce the app's UI nesting.",
      );
    const parent = stack.at(-1);
    const path = parent ? `${parent.path}_${parent.next++}` : String(nodes.length);
    const retain =
      count <= limits.maxNodes &&
      stack.length <= limits.maxDepth &&
      (!parent || parent.node !== undefined);
    const node = retain ? mapped(attributes(tag), path) : undefined;
    if (node) {
      if (parent?.node) parent.node.children.push(node);
      else nodes.push(node);
    } else truncated = true;
    if (!tag.endsWith("/>")) stack.push({ node, next: 0, path });
  }
  if (!opened || !closed || stack.length || xml.slice(cursor).trim())
    throw new DeviceError("invalid_data", "Incomplete Android UI XML", "Refresh the device tree.");
  return ScreenUITreeResult.parse({ nodes, truncated });
}
export function androidFind(tree: ScreenUITreeResult, options: unknown): ScreenUIFindResult {
  const { query, limit } = ScreenUIFindOptions.parse(options);
  const nodes: Node[] = [];
  const pending = tree.nodes.toReversed();
  let truncated = tree.truncated;
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    const matches =
      (query.role === undefined || node.role.toLowerCase().includes(query.role.toLowerCase())) &&
      (query.name === undefined || node.name.toLowerCase().includes(query.name.toLowerCase())) &&
      (query.text === undefined ||
        (node.value ?? node.name).toLowerCase().includes(query.text.toLowerCase()));
    if (matches) {
      if (nodes.length >= limit) {
        truncated = true;
        break;
      }
      nodes.push({ ...node, children: [] });
    }
    for (let index = node.children.length - 1; index >= 0; index--) {
      const child = node.children[index];
      if (child) pending.push(child);
    }
  }
  return ScreenUIFindResult.parse({ nodes, truncated });
}
export function androidTarget(tree: ScreenUITreeResult, ref: string): Node {
  const pending = [...tree.nodes];
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    if (node.ref === ref) return node;
    pending.push(...node.children);
  }
  throw new DeviceError(
    "stale_ref",
    "Android UI target is stale or no longer visible",
    "Read the UI tree again before acting.",
  );
}
