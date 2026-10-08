/**
 * Every themeable CSS variable, in the groups the Theme editor shows. A theme stores a value for
 * each of these; everything else (foreground aliases, materials, the accent ring) is derived in
 * CSS from them, so editing one token keeps the whole theme coherent.
 */
export const tokenGroups = [
  {
    name: "Surfaces",
    tokens: [
      "--background",
      "--reading-rgb",
      "--sidebar-rgb",
      "--popover",
      "--card",
      "--secondary",
      "--muted",
      "--accent",
      "--border",
      "--input",
      "--code",
      "--bubble",
    ],
  },
  {
    name: "Text",
    tokens: [
      "--foreground",
      "--muted-foreground",
      "--subtle-foreground",
      "--primary",
      "--primary-foreground",
      "--destructive",
    ],
  },
  { name: "Sidebar", tokens: ["--sidebar-foreground", "--sidebar-accent", "--sidebar-border"] },
  {
    name: "Status",
    tokens: [
      "--status-needs-you",
      "--status-working",
      "--status-waiting",
      "--status-unresponsive",
      "--status-failed",
      "--status-done",
    ],
  },
  {
    name: "Accent",
    tokens: [
      "--accent-theme",
      "--accent-blue",
      "--accent-violet",
      "--accent-teal",
      "--accent-amber",
      "--accent-rose",
      "--accent-graphite",
    ],
  },
  {
    name: "Glass",
    tokens: [
      "--glass-rgb",
      "--glass-a",
      "--glass-blur",
      "--glass-border",
      "--glass-edge",
      "--glass-highlight",
      "--glass-shadow",
    ],
  },
  { name: "Diff", tokens: ["--diff-add", "--diff-del"] },
  {
    name: "Project badges",
    tokens: [
      "--project-1",
      "--project-2",
      "--project-3",
      "--project-4",
      "--project-5",
      "--project-6",
      "--project-7",
      "--project-8",
      "--project-9",
      "--project-10",
      "--project-11",
      "--project-12",
    ],
  },
  { name: "Wallpaper", tokens: ["--wall", "--w1", "--w2", "--w3", "--w4"] },
  { name: "Shape", tokens: ["--radius-sm", "--radius", "--radius-lg", "--radius-xl"] },
] as const;

export type TokenName = (typeof tokenGroups)[number]["tokens"][number];
export type ThemeTokens = Record<TokenName, string>;

export const tokenNames: readonly TokenName[] = tokenGroups.flatMap((group) => group.tokens);

/** Labels shared by theme controls; variables remain available as secondary text. */
export const tokenLabels: Record<TokenName, string> = {
  "--background": "Window background",
  "--reading-rgb": "Main column background",
  "--sidebar-rgb": "Sidebar background",
  "--popover": "Menu background",
  "--card": "Summary background",
  "--secondary": "Control background",
  "--muted": "Muted background",
  "--accent": "Hover background",
  "--border": "Dividers",
  "--input": "Input borders",
  "--code": "Code background",
  "--bubble": "Your message background",
  "--foreground": "Main text",
  "--muted-foreground": "Secondary text",
  "--subtle-foreground": "Quiet text",
  "--primary": "Tooltip background",
  "--primary-foreground": "Tooltip text",
  "--destructive": "Error text",
  "--sidebar-foreground": "Sidebar text",
  "--sidebar-accent": "Sidebar selection",
  "--sidebar-border": "Sidebar dividers",
  "--accent-theme": "Theme accent",
  "--glass-rgb": "Floating background",
  "--glass-a": "Floating opacity",
  "--glass-blur": "Background blur",
  "--glass-border": "Floating border",
  "--glass-edge": "Floating edge",
  "--glass-highlight": "Floating highlight",
  "--glass-shadow": "Floating shadow",
  "--diff-add": "Added lines",
  "--diff-del": "Removed lines",
  "--wall": "Wallpaper base",
  "--w1": "Wallpaper colour 1",
  "--w2": "Wallpaper colour 2",
  "--w3": "Wallpaper colour 3",
  "--w4": "Wallpaper colour 4",
  "--radius-sm": "Small corner radius",
  "--radius": "Corner radius",
  "--radius-lg": "Large corner radius",
  "--radius-xl": "Extra large corner radius",
  "--status-needs-you": "Needs you",
  "--status-working": "Working",
  "--status-waiting": "Waiting",
  "--status-unresponsive": "Not responding",
  "--status-failed": "Failed",
  "--status-done": "Done",
  "--accent-blue": "Blue accent",
  "--accent-violet": "Violet accent",
  "--accent-teal": "Teal accent",
  "--accent-amber": "Amber accent",
  "--accent-rose": "Rose accent",
  "--accent-graphite": "Graphite accent",
  "--project-1": "Project colour 1",
  "--project-2": "Project colour 2",
  "--project-3": "Project colour 3",
  "--project-4": "Project colour 4",
  "--project-5": "Project colour 5",
  "--project-6": "Project colour 6",
  "--project-7": "Project colour 7",
  "--project-8": "Project colour 8",
  "--project-9": "Project colour 9",
  "--project-10": "Project colour 10",
  "--project-11": "Project colour 11",
  "--project-12": "Project colour 12",
};

/** What a token's value is, so the editor can refuse what CSS would drop. */
export type TokenKind = "color" | "rgbTriple" | "alpha" | "length" | "shadow";

const tokenKinds: Partial<Record<TokenName, TokenKind>> = {
  "--reading-rgb": "rgbTriple",
  "--sidebar-rgb": "rgbTriple",
  "--glass-rgb": "rgbTriple",
  "--glass-a": "alpha",
  "--glass-blur": "length",
  "--glass-highlight": "shadow",
  "--glass-shadow": "shadow",
  "--radius-sm": "length",
  "--radius": "length",
  "--radius-lg": "length",
  "--radius-xl": "length",
};

/** A token's kind; anything not listed is a colour. */
export function tokenKind(token: TokenName): TokenKind {
  return tokenKinds[token] ?? "color";
}

const hexColour = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const colourFunction = /^(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color|color-mix)\(.+\)$/i;
const tripleValue = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/;
const lengthValue = /^(?:0|\d*\.?\d+(?:px|rem|em|%))$/;

type Supports = (property: string, value: string) => boolean;

/** The browser's own check when it has one (`CSS.supports`); none in a test DOM. */
function browserSupports(): Supports | undefined {
  const css: unknown = Reflect.get(globalThis, "CSS");
  const supports: unknown =
    css && typeof css === "object" ? Reflect.get(css, "supports") : undefined;
  return typeof supports === "function"
    ? (property, value) => Boolean(Reflect.apply(supports, css, [property, value]))
    : undefined;
}

/** Whether `value` is a usable value for a token of `kind`. */
export function isValidTokenValue(
  kind: TokenKind,
  value: string,
  supports: Supports | undefined = browserSupports(),
): boolean {
  const text = value.trim();
  if (!text || /[{};]/.test(text)) return false;
  switch (kind) {
    case "rgbTriple": {
      const match = tripleValue.exec(text);
      return match !== null && match.slice(1).every((part) => Number(part) <= 255);
    }
    case "alpha": {
      const number = Number(text);
      return /^\d*\.?\d+$/.test(text) && number >= 0 && number <= 1;
    }
    case "length":
      return lengthValue.test(text) && (supports?.("width", text) ?? true);
    case "shadow":
      return supports ? supports("box-shadow", text) : text === "none" || /\d/.test(text);
    case "color":
      return supports
        ? supports("color", text)
        : hexColour.test(text) || colourFunction.test(text) || /^[a-z]+$/i.test(text);
  }
}

/** What to tell someone whose value was refused. */
export const tokenKindHints: Record<TokenKind, string> = {
  color: "Not a colour",
  rgbTriple: "Use three numbers from 0 to 255, like 24 24 27",
  alpha: "Use a number from 0 to 1",
  length: "Use a length, like 10px",
  shadow: "Not a shadow",
};
