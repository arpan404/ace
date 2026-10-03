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
      "--rail-rgb",
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
    name: "Accent presets",
    tokens: [
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
  { name: "Wallpaper", tokens: ["--wall", "--w1", "--w2", "--w3", "--w4"] },
  { name: "Shape", tokens: ["--radius-sm", "--radius", "--radius-lg", "--radius-xl"] },
] as const;

export type TokenName = (typeof tokenGroups)[number]["tokens"][number];
export type ThemeTokens = Record<TokenName, string>;

export const tokenNames: readonly TokenName[] = tokenGroups.flatMap((group) => group.tokens);

export const tokenHints: Partial<Record<TokenName, string>> = {
  "--reading-rgb": "r g b of the main column; alpha comes from Glass intensity",
  "--sidebar-rgb": "r g b of the second sidebar",
  "--rail-rgb": "r g b of the rail",
  "--glass-rgb": "r g b of floating glass",
  "--glass-a": "0..1 opacity of glass at full intensity",
  "--card": "cards and files summary",
  "--bubble": "user message bubble",
  "--code": "code blocks and terminal",
  "--primary": "ink buttons",
};
