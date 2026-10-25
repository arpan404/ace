import type { DeviceChrome } from "@ace/protocol/devices";

/*
 * An Android emulator skin's look: its `layout` file (a tree of `name { ... }` blocks and
 * `key value` lines) says the portrait picture, the screen's shape and where the display sits
 * in it. Pure: the layout text and a reader for the images it names come in.
 */

export interface LayoutNode {
  values: Map<string, string>;
  children: Map<string, LayoutNode>;
}

const emptyNode = (): LayoutNode => ({ values: new Map(), children: new Map() });

/** The layout file as a tree. Lines it can't read are skipped. */
export function parseSkinLayout(text: string): LayoutNode {
  const root = emptyNode();
  const stack = [root];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const current = stack[stack.length - 1] ?? root;
    if (line === "}") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const open = /^(\S+)\s*\{$/.exec(line);
    if (open?.[1]) {
      const child = current.children.get(open[1]) ?? emptyNode();
      current.children.set(open[1], child);
      if (stack.length < 32) stack.push(child);
      continue;
    }
    const pair = /^(\S+)\s+(.+)$/.exec(line);
    if (pair?.[1] && pair[2]) current.values.set(pair[1], pair[2].trim());
  }
  return root;
}

const child = (node: LayoutNode | undefined, ...path: string[]) =>
  path.reduce<LayoutNode | undefined>((at, key) => at?.children.get(key), node);
const number = (node: LayoutNode | undefined, key: string) => {
  const value = Number(node?.values.get(key));
  return Number.isFinite(value) ? value : undefined;
};
const fileName = (value: string | undefined) =>
  value && /^[^/\\\0]+\.(?:webp|png)$/i.test(value) ? value : undefined;

/** Reads one of the skin's images as a data URL, or undefined. */
export type SkinImageReader = (file: string) => Promise<string | undefined>;

/**
 * The skin's upright look: the portrait picture as the body, the display's place in it, and the
 * screen mask when the skin has one. Undefined when the layout has no usable portrait.
 */
export async function androidSkinChrome(
  layout: string,
  read: SkinImageReader,
): Promise<DeviceChrome | undefined> {
  const tree = parseSkinLayout(layout);
  const portrait = child(tree, "layouts", "portrait");
  const width = number(portrait, "width");
  const height = number(portrait, "height");
  if (!portrait || !width || !height || width <= 0 || height <= 0) return undefined;
  const parts = [...portrait.children.values()].filter((node) => node.values.has("name"));
  const device = parts.find((part) => part.values.get("name") === "device");
  const backdrop = parts.find((part) => part.values.get("name") !== "device");
  if (!device || !backdrop || (number(device, "rotation") ?? 0) !== 0) return undefined;
  // The picture fills the layout; a skin that offsets it isn't one ace draws.
  if ((number(backdrop, "x") ?? 0) !== 0 || (number(backdrop, "y") ?? 0) !== 0) return undefined;
  const look = child(tree, "parts", backdrop.values.get("name") ?? "");
  const display = child(tree, "parts", "device", "display");
  const screen = {
    x: (number(device, "x") ?? 0) + (number(display, "x") ?? 0),
    y: (number(device, "y") ?? 0) + (number(display, "y") ?? 0),
    width: number(display, "width") ?? 0,
    height: number(display, "height") ?? 0,
  };
  if (screen.width <= 0 || screen.height <= 0) return undefined;
  const backgroundFile = fileName(child(look, "background")?.values.get("image"));
  const maskFile = fileName(child(look, "foreground")?.values.get("mask"));
  if (!backgroundFile) return undefined;
  const [image, mask] = await Promise.all([
    read(backgroundFile),
    maskFile ? read(maskFile) : undefined,
  ]);
  if (!image) return undefined;
  return {
    body: { width, height, image },
    screen,
    ...(mask ? { mask } : {}),
    buttons: [],
  };
}
