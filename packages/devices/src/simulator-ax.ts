import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ScreenUITreeOptions,
  ScreenUITreeResult,
  type ScreenUINode,
  type ScreenUIActOptions,
} from "@ace/protocol";
import { DeviceError } from "./sdk.ts";

/**
 * One element of serve-sim's `/ax` answer: a nested accessibility tree with frames in iOS
 * points. Fields are read leniently; unknown fields are ignored and missing ones default.
 */
const Frame = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});
const text = z
  .string()
  .nullish()
  .catch(undefined)
  .transform((value) => value ?? "");
const Element = z.object({
  AXLabel: text,
  AXValue: text,
  AXUniqueId: text,
  type: text,
  role_description: text,
  enabled: z.boolean().catch(true).default(true),
  frame: Frame,
  children: z.array(z.unknown()).max(4096).catch([]).default([]),
});
type Element = z.infer<typeof Element>;
const Roots = z.array(z.unknown()).max(64);

const pressable = new Set([
  "Button",
  "Cell",
  "Link",
  "Image",
  "Icon",
  "Key",
  "MenuItem",
  "Tab",
  "TabBarButton",
  "SegmentedControl",
  "StaticText",
  "Switch",
  "Toggle",
  "CheckBox",
  "RadioButton",
  "PopUpButton",
  "DisclosureTriangle",
]);
const editable = new Set(["TextField", "SecureTextField", "SearchField", "TextView", "TextArea"]);
const scrollable = new Set(["ScrollView", "Table", "CollectionView", "List", "WebView"]);
const toggles = new Set(["Switch", "Toggle", "CheckBox"]);

/**
 * Map serve-sim's accessibility tree to ADR 0011 nodes. Bounds are converted from points to
 * framebuffer pixels (the coordinates of live-view frames and device input) with `scale`, the
 * framebuffer width over the root's width in points.
 */
export function simulatorTree(
  raw: unknown,
  screen: { width: number; height: number },
  options: unknown,
): ScreenUITreeResult {
  const limits = ScreenUITreeOptions.parse(options);
  const roots = Roots.safeParse(raw);
  if (!roots.success)
    throw new DeviceError(
      "invalid_data",
      "Simulator accessibility tree is malformed",
      "Read the UI tree again; restart the live view if it keeps failing.",
    );
  const first = Element.safeParse(roots.data[0]);
  const points = first.success ? first.data.frame.width : 0;
  const scale = points > 0 && screen.width > 0 ? screen.width / points : 1;
  const nodes: ScreenUINode[] = [];
  let count = 0;
  let truncated = false;
  const pending: { raw: unknown; depth: number; path: string; parent: ScreenUINode[] }[] = [];
  for (let index = roots.data.length - 1; index >= 0; index--)
    pending.push({ raw: roots.data[index], depth: 0, path: String(index), parent: nodes });
  while (pending.length) {
    const item = pending.pop();
    if (!item) break;
    const element = Element.safeParse(item.raw);
    // An element without a usable frame is skipped with its subtree, never fatal.
    if (!element.success) continue;
    if (++count > limits.maxNodes || item.depth > limits.maxDepth) {
      truncated = true;
      continue;
    }
    const node = mapped(element.data, item.path, scale, screen);
    item.parent.push(node);
    const children = element.data.children;
    for (let index = children.length - 1; index >= 0; index--)
      pending.push({
        raw: children[index],
        depth: item.depth + 1,
        path: `${item.path}_${index}`,
        parent: node.children,
      });
  }
  return ScreenUITreeResult.parse({ nodes, truncated });
}

function mapped(
  element: Element,
  path: string,
  scale: number,
  screen: { width: number; height: number },
): ScreenUINode {
  const kind = element.type || element.role_description || "element";
  const name = element.AXLabel || element.AXUniqueId;
  const bounds = {
    x: Math.round(element.frame.x * scale),
    y: Math.round(element.frame.y * scale),
    w: Math.round(element.frame.width * scale),
    h: Math.round(element.frame.height * scale),
  };
  const states: ScreenUINode["states"] = [];
  if (toggles.has(kind) && element.AXValue === "1") states.push("checked");
  if (!element.enabled) states.push("disabled");
  if (
    bounds.x + bounds.w <= 0 ||
    bounds.y + bounds.h <= 0 ||
    (screen.width > 0 && bounds.x >= screen.width) ||
    (screen.height > 0 && bounds.y >= screen.height)
  )
    states.push("offscreen");
  const actions: ScreenUINode["actions"] = [];
  if (element.enabled && bounds.w > 0 && bounds.h > 0 && !states.includes("offscreen")) {
    if (pressable.has(kind)) actions.push("press");
    if (editable.has(kind)) actions.push("press", "focus");
    if (scrollable.has(kind)) actions.push("scroll");
    if (toggles.has(kind)) actions.push("select");
  }
  // The ref names this element at this place in this tree. A later read where it moved,
  // changed label or changed identity yields a different ref, so an old ref goes stale.
  const identity = [path, kind, element.AXUniqueId, element.AXLabel, bounds];
  const ref = `i_${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 40)}`;
  return {
    ref,
    role: kind.slice(0, 128),
    name: name.slice(0, 256),
    ...(element.AXValue ? { value: element.AXValue.slice(0, 512) } : {}),
    ...(element.AXUniqueId && element.AXUniqueId !== name
      ? { description: element.AXUniqueId.slice(0, 256) }
      : {}),
    bounds,
    states,
    actions,
    children: [],
  };
}

/** Find the node a ref names in a fresh tree; a ref absent from it is stale. */
export function simulatorTarget(tree: ScreenUITreeResult, ref: string): ScreenUINode {
  const pending = [...tree.nodes];
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    if (node.ref === ref) return node;
    pending.push(...node.children);
  }
  throw new DeviceError(
    "stale_ref",
    "Simulator UI target is stale or no longer visible",
    "Read the UI tree again before acting.",
  );
}

const clamp = (value: number, start: number, size: number) =>
  Math.max(start, Math.min(start + size - 1, value));

/** The device input that performs a semantic action on a node, or why it can't be done. */
export function simulatorActionInput(
  node: ScreenUINode,
  action: ScreenUIActOptions,
):
  | { kind: "tap"; x: number; y: number }
  | { kind: "swipe"; x: number; y: number; toX: number; toY: number; durationMs: number }
  | { kind: "none"; method: string } {
  if (!node.actions.includes(action.action) || node.states.includes("disabled"))
    throw new DeviceError(
      "not_supported",
      "Simulator UI target does not support this action",
      "Read supported actions from the current tree.",
    );
  const centre = {
    x: Math.floor(node.bounds.x + node.bounds.w / 2),
    y: Math.floor(node.bounds.y + node.bounds.h / 2),
  };
  if (action.action === "select" && typeof action.value === "boolean")
    if (node.states.includes("checked") === action.value)
      return { kind: "none", method: "already_selected" };
  if (action.action !== "scroll") return { kind: "tap", ...centre };
  const scroll = z
    .object({
      dx: z.number().int().min(-1000).max(1000).default(0),
      dy: z.number().int().min(-1000).max(1000).default(0),
    })
    .parse(action.value ?? {});
  if (!scroll.dx && !scroll.dy) return { kind: "none", method: "no_scroll" };
  return {
    kind: "swipe",
    ...centre,
    toX: clamp(centre.x - scroll.dx, node.bounds.x, node.bounds.w),
    toY: clamp(centre.y - scroll.dy, node.bounds.y, node.bounds.h),
    durationMs: 300,
  };
}
