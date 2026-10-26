import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ScreenUITreeOptions,
  ScreenUITreeResult,
  type ScreenUINode,
  type ScreenUIActOptions,
} from "@ace/protocol";
import { DeviceError } from "./sdk.ts";
import { simulatorRotation, type FrameRotation } from "./simulator-rotation.ts";

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
 * Turns a rectangle in the screen's upright layout into the portrait framebuffer, which stays
 * put when the device turns. Coordinates are 0..1 of each; `turn` is the clockwise turn that
 * shows the framebuffer upright, so this undoes it (as viewers do for a pointer).
 */
function unturn(
  rect: { x: number; y: number; w: number; h: number },
  turn: FrameRotation,
): { x: number; y: number; w: number; h: number } {
  const point = (u: number, v: number): [number, number] =>
    turn === 90 ? [v, 1 - u] : turn === 180 ? [1 - u, 1 - v] : turn === 270 ? [1 - v, u] : [u, v];
  const [ax, ay] = point(rect.x, rect.y);
  const [bx, by] = point(rect.x + rect.w, rect.y + rect.h);
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    w: Math.abs(bx - ax),
    h: Math.abs(by - ay),
  };
}

/** How a tree's points sit on the framebuffer: the layout's size in points and its turn. */
export interface SimulatorLayout {
  width: number;
  height: number;
  turn: FrameRotation;
}

/**
 * The app's layout under serve-sim's tree. iOS lays elements out in the app's own orientation,
 * which is not always the device's: a portrait-only app stays portrait on a turned iPhone,
 * while an iPhone Duo's inner screen is landscape. The root reports the window's portrait frame
 * either way, so on a device turned a quarter the elements' reach decides: past the portrait
 * width, the layout is turned with it. A device held upright is taken at its word, so a portrait
 * app's off-screen pages or carousels never read as a turned layout.
 */
export function simulatorLayout(
  raw: unknown,
  screen: { width: number; height: number; orientation?: string },
): SimulatorLayout {
  const roots = Roots.safeParse(raw);
  const first = roots.success ? Element.safeParse(roots.data[0]) : undefined;
  const root = first?.success ? first.data.frame : undefined;
  if (!roots.success || !root || !root.width || !root.height)
    return { width: screen.width, height: screen.height, turn: 0 };
  const short = Math.min(root.width, root.height);
  const long = Math.max(root.width, root.height);
  const portrait = screen.width <= screen.height;
  // The furthest any element reaches across the framebuffer's short side, from a bounded walk.
  let reach = 0;
  const pending = [...roots.data];
  for (let seen = 0; pending.length && seen < 512; seen++) {
    const element = Element.safeParse(pending.pop());
    if (!element.success) continue;
    const { frame } = element.data;
    reach = Math.max(reach, portrait ? frame.x + frame.width : frame.y + frame.height);
    pending.push(...element.data.children);
  }
  const device = simulatorRotation(screen.orientation ?? "portrait");
  const turned = device % 180 !== 0 && reach > short * 1.05;
  const turn: FrameRotation = turned ? device : 0;
  return turned === portrait
    ? { width: long, height: short, turn }
    : { width: short, height: long, turn };
}

/**
 * Map serve-sim's accessibility tree to ADR 0011 nodes. Bounds are converted from the layout's
 * points to framebuffer pixels (the coordinates of live-view frames and device input), turned
 * back onto the framebuffer when the layout is turned.
 */
export function simulatorTree(
  raw: unknown,
  screen: { width: number; height: number; orientation?: string },
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
  const layout = simulatorLayout(raw, screen);
  const { turn } = layout;
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
    const node = mapped(element.data, item.path, layout, turn, screen);
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
  layout: { width: number; height: number },
  turn: FrameRotation,
  screen: { width: number; height: number },
): ScreenUINode {
  const kind = element.type || element.role_description || "element";
  const name = element.AXLabel || element.AXUniqueId;
  const shown = unturn(
    {
      x: element.frame.x / layout.width,
      y: element.frame.y / layout.height,
      w: element.frame.width / layout.width,
      h: element.frame.height / layout.height,
    },
    turn,
  );
  const bounds = {
    x: Math.round(shown.x * screen.width),
    y: Math.round(shown.y * screen.height),
    w: Math.round(shown.w * screen.width),
    h: Math.round(shown.h * screen.height),
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

/**
 * The device input that performs a semantic action on a node, or why it can't be done. A scroll
 * is asked for in the upright layout; on a turned device it runs across the framebuffer.
 */
export function simulatorActionInput(
  node: ScreenUINode,
  action: ScreenUIActOptions,
  turn: FrameRotation = 0,
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
  const [dx, dy] =
    turn === 90
      ? [scroll.dy, -scroll.dx]
      : turn === 180
        ? [-scroll.dx, -scroll.dy]
        : turn === 270
          ? [-scroll.dy, scroll.dx]
          : [scroll.dx, scroll.dy];
  return {
    kind: "swipe",
    ...centre,
    toX: clamp(centre.x - dx, node.bounds.x, node.bounds.w),
    toY: clamp(centre.y - dy, node.bounds.y, node.bounds.h),
    durationMs: 300,
  };
}
