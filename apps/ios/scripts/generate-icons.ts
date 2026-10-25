import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Writes ace's Phosphor icons (DESIGN.md "Icons": Phosphor only, regular weight, bold only at
 * 12pt) into `Shared/Icons.xcassets` as vector template images, and the Swift names the app
 * draws them by into `Shared/AceIcon.generated.swift`:
 *
 *   bun scripts/generate-icons.ts
 *
 * Path data comes from the installed `@phosphor-icons/react` package (MIT, the same icons the
 * web app draws). Every icon is written in `regular` (`ph-<name>`) and `bold`
 * (`ph-<name>-bold`). Add an icon by adding its Phosphor name to `extra`, or a row to
 * `fromSymbols` when it replaces an SF Symbol. The outputs are committed.
 */

/**
 * SF Symbol → Phosphor, for every symbol the app drew before it moved to Phosphor. Swapping a
 * call site is mechanical: `Image(systemName: "folder")` becomes `AceIcon(.folder)`, and
 * `Label("Copy", systemImage: "doc.on.doc")` becomes `Label("Copy", ace: .copy)`.
 * System chrome iOS draws itself (back chevron, share sheet, keyboard) stays native.
 */
export const fromSymbols: Record<string, string> = {
  "1.magnifyingglass": "magnifying-glass",
  "antenna.radiowaves.left.and.right": "broadcast",
  app: "app-window",
  "apple.terminal": "terminal-window",
  appletv: "television",
  applewatch: "watch",
  archivebox: "archive",
  "arrow.clockwise": "arrow-clockwise",
  "arrow.down": "arrow-down",
  "arrow.down.circle": "arrow-circle-down",
  "arrow.down.doc": "file-arrow-down",
  "arrow.left.arrow.right": "arrows-left-right",
  "arrow.right": "arrow-right",
  "arrow.triangle.branch": "git-branch",
  "arrow.triangle.merge": "git-merge",
  "arrow.turn.down.right": "arrow-elbow-down-right",
  "arrow.up": "arrow-up",
  "arrow.up.circle": "arrow-circle-up",
  "arrow.uturn.backward": "arrow-u-up-left",
  at: "at",
  bell: "bell",
  bolt: "lightning",
  book: "book-open",
  brain: "brain",
  "bubble.left": "chat-circle",
  "bubble.left.and.bubble.right": "chats",
  "bubble.left.and.text.bubble.right": "chats-teardrop",
  "button.vertical.right.press": "hand-tap",
  camera: "camera",
  "character.bubble": "translate",
  "chart.bar": "chart-bar",
  "chart.bar.doc.horizontal": "chart-bar-horizontal",
  checklist: "list-checks",
  checkmark: "check",
  "checkmark.circle": "check-circle",
  "checkmark.circle.fill": "check-circle",
  "checkmark.shield": "shield-check",
  "checkmark.square.fill": "check-square",
  "chevron.backward": "caret-left",
  "chevron.down": "caret-down",
  "chevron.forward": "caret-right",
  "chevron.left": "caret-left",
  "chevron.left.forwardslash.chevron.right": "code",
  "chevron.right": "caret-right",
  "chevron.up": "caret-up",
  "chevron.up.chevron.down": "caret-up-down",
  circle: "circle",
  "circle.dashed": "circle-dashed",
  "circle.lefthalf.filled": "circle-half",
  "circle.slash": "prohibit",
  "clock.arrow.circlepath": "clock-counter-clockwise",
  clock: "clock",
  cloud: "cloud",
  command: "command",
  cpu: "cpu",
  cursorarrow: "cursor",
  desktopcomputer: "desktop",
  display: "monitor",
  doc: "file",
  "doc.badge.plus": "file-plus",
  "doc.on.doc": "copy",
  "doc.questionmark": "file-dashed",
  "doc.richtext": "file-text",
  "doc.text": "file-text",
  "doc.text.magnifyingglass": "file-magnifying-glass",
  ellipsis: "dots-three",
  "ellipsis.circle": "dots-three-circle",
  "exclamationmark.circle": "warning-circle",
  "exclamationmark.triangle": "warning",
  "externaldrive.badge.exclamationmark": "hard-drive",
  eye: "eye",
  faceid: "scan-smiley",
  folder: "folder",
  "folder.badge.plus": "folder-plus",
  "gearshape.2": "gear-six",
  gearshape: "gear",
  globe: "globe",
  "hand.raised": "hand",
  hourglass: "hourglass",
  house: "house",
  "info.circle": "info",
  internaldrive: "hard-drive",
  ipad: "device-tablet",
  iphone: "device-mobile",
  key: "key",
  keyboard: "keyboard",
  "keyboard.chevron.compact.down": "keyboard",
  laptopcomputer: "laptop",
  lightbulb: "lightbulb",
  "line.3.horizontal.decrease": "funnel-simple",
  link: "link",
  "list.bullet": "list-bullets",
  "list.bullet.indent": "tree-view",
  location: "map-pin",
  lock: "lock",
  "lock.fill": "lock",
  macwindow: "app-window",
  "macwindow.on.rectangle": "browsers",
  magnifyingglass: "magnifying-glass",
  minus: "minus",
  "minus.circle": "minus-circle",
  "minus.magnifyingglass": "magnifying-glass-minus",
  moon: "moon",
  "moon.zzz": "bell-simple-z",
  network: "network",
  nosign: "prohibit",
  paintpalette: "palette",
  paperclip: "paperclip",
  pause: "pause",
  "pause.circle": "pause-circle",
  pencil: "pencil-simple",
  "person.2": "users",
  "person.badge.plus": "user-plus",
  "person.crop.circle": "user-circle",
  "person.text.rectangle": "identification-card",
  phone: "phone",
  photo: "image",
  "photo.on.rectangle": "images",
  play: "play",
  plus: "plus",
  "plus.magnifyingglass": "magnifying-glass-plus",
  "plus.square.on.square": "plus-square",
  plusminus: "plus-minus",
  "point.3.connected.trianglepath.dotted": "graph",
  power: "power",
  "qrcode.viewfinder": "qr-code",
  "questionmark.bubble": "question",
  "record.circle": "record",
  "rotate.right": "device-rotate",
  safari: "compass",
  scope: "crosshair",
  scroll: "scroll",
  "server.rack": "hard-drives",
  shippingbox: "package",
  "slider.horizontal.3": "sliders-horizontal",
  smartphone: "device-mobile",
  sparkle: "sparkle",
  "sparkle.magnifyingglass": "binoculars",
  sparkles: "sparkle",
  square: "square",
  "square.and.arrow.up": "export",
  "square.and.pencil": "note-pencil",
  "square.on.square": "browsers",
  stop: "stop",
  "stop.circle": "stop-circle",
  "sun.max": "sun",
  terminal: "terminal",
  "text.alignleft": "text-align-left",
  "text.bubble": "chat-text",
  "text.line.last.and.arrowtriangle.forward": "queue",
  "text.word.spacing": "text-align-justify",
  target: "target",
  timer: "timer",
  trash: "trash",
  tray: "tray",
  "tray.and.arrow.up": "tray-arrow-up",
  tv: "television",
  visionpro: "virtual-reality",
  "widget.small": "squares-four",
  "wifi.exclamationmark": "wifi-x",
  "wifi.slash": "wifi-slash",
  "wrench.and.screwdriver": "wrench",
  xmark: "x",
  "xmark.circle": "x-circle",
  "xmark.circle.fill": "x-circle",
  "xmark.square": "x-square",
};

/** Icons the redesign draws that no SF Symbol stood for. */
const extra = [
  "arrow-bend-down-right",
  "arrow-square-out",
  "arrows-in-line-vertical",
  "caret-double-down",
  "chat-teardrop-text",
  "arrows-out-simple",
  "folder-simple",
  "git-pull-request",
  "hammer",
  "list",
  "note",
  "plug",
  "robot",
  "sidebar-simple",
  "tree-structure",
  "user",
  // Reactions and comment actions on pull requests and issues, as the web draws them.
  "thumbs-up",
  "thumbs-down",
  "smiley",
  "confetti",
  "smiley-meh",
  "heart",
  "rocket-launch",
  "eyes",
  "smiley-sticker",
  "arrow-bend-up-left",
  "link-simple",
  "eye-slash",
  "bell-slash",
  "envelope-open",
  "lock-open",
  "flag",
  "play-circle",
];

const pascal = (name: string) =>
  name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
const camel = (name: string) => {
  const value = pascal(name);
  return value.charAt(0).toLowerCase() + value.slice(1);
};
const swiftKeywords = new Set(["repeat", "function", "subtract", "return", "default", "case"]);
const swiftCase = (name: string) =>
  swiftKeywords.has(camel(name)) ? `\`${camel(name)}\`` : camel(name);
const attribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

interface Element {
  t: string;
  p: Record<string, string> | null;
  c: Element[];
}
type Weights = Map<string, Element>;

/**
 * A Phosphor definition module maps each weight to a React fragment of `<path>`s. It is read
 * with a stand-in `createElement` that records the tree instead of rendering it.
 */
async function weightsOf(defs: string, name: string): Promise<Weights> {
  const source = await readFile(join(defs, `${pascal(name)}.es.js`), "utf8");
  const body = source
    .replace(
      /^import \* as (\w+) from "react";/m,
      "const $1 = { Fragment: 'fragment', createElement: (t, p, ...c) => ({ t, p, c }) };",
    )
    .replace(/export\s*\{\s*(\w+) as default\s*\};?\s*$/m, "return $1;");
  // oxlint-disable-next-line no-new-func -- evaluates the installed package's own definition
  const weights: unknown = new Function(body)();
  if (!(weights instanceof Map)) throw new Error(`Unexpected Phosphor definition for ${name}.`);
  return weights as Weights;
}

function svgOf(fragment: Element): string {
  const paths: string[] = [];
  const visit = (node: Element) => {
    if (node.t === "path" && node.p?.d) {
      const opacity = node.p.opacity === undefined ? "" : ` opacity="${attribute(node.p.opacity)}"`;
      paths.push(`<path d="${attribute(node.p.d)}"${opacity}/>`);
    } else if (node.t !== "fragment") throw new Error(`Unexpected <${node.t}> in a Phosphor icon.`);
    for (const child of node.c) if (child && typeof child === "object") visit(child);
  };
  visit(fragment);
  // 20pt intrinsic size: what a menu or swipe action draws when it can't size the image itself.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="20" height="20" fill="#000000">${paths.join("")}</svg>\n`;
}

const root = join(import.meta.dirname, "..");
const folder = join(root, "Shared", "Icons.xcassets");
const defs = join(dirname(fileURLToPath(import.meta.resolve("@phosphor-icons/react"))), "defs");
const names = [...new Set([...Object.values(fromSymbols), ...extra])].toSorted();

await rm(folder, { recursive: true, force: true });
await mkdir(folder, { recursive: true });
await writeFile(
  join(folder, "Contents.json"),
  `${JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2)}\n`,
);
for (const name of names) {
  const weights = await weightsOf(defs, name);
  for (const weight of ["regular", "bold"] as const) {
    const fragment = weights.get(weight);
    if (!fragment) throw new Error(`Phosphor has no ${weight} ${name}.`);
    const asset = weight === "regular" ? `ph-${name}` : `ph-${name}-bold`;
    const set = join(folder, `${asset}.imageset`);
    await mkdir(set, { recursive: true });
    await writeFile(join(set, `${asset}.svg`), svgOf(fragment));
    const contents = {
      images: [{ filename: `${asset}.svg`, idiom: "universal" }],
      info: { author: "xcode", version: 1 },
      properties: {
        "preserves-vector-representation": true,
        "template-rendering-intent": "template",
      },
    };
    await writeFile(join(set, "Contents.json"), `${JSON.stringify(contents, null, 2)}\n`);
  }
}

const swift = [
  "// Generated by scripts/generate-icons.ts from @phosphor-icons/react. Do not edit.",
  "",
  "extension AceIcon {",
  "    /// Every Phosphor icon in `Icons.xcassets`; the raw value is its Phosphor name.",
  "    enum Name: String, CaseIterable, Sendable {",
  ...names.map((name) => `        case ${swiftCase(name)} = "${name}"`),
  "    }",
  "}",
  "",
].join("\n");
await writeFile(join(root, "Shared", "AceIcon.generated.swift"), swift);
await writeFile(
  join(root, "Resources", "Licences", "phosphor-icons-license.txt"),
  await readFile(join(defs, "..", "..", "LICENSE"), "utf8"),
);
console.log(`Wrote ${names.length} Phosphor icons to ${folder}`);
