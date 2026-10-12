/*
 * The six themes, each hand-tuned in light and dark (docs/design/visual-language.md). These are
 * the only colours the app owns: every CSS token is derived from one palette in `tokens.ts`.
 * Values come from the approved design prototype and pass WCAG AA on every surface (`contrast.ts`);
 * quiet text (`t3`) is a step stronger than the prototype's so it still reads on a highlighted row.
 */

export type Scheme = "light" | "dark";

export interface Palette {
  /** Page and reading column. */
  s0: string;
  /** Quiet raised fills: bubbles, cards, hunk headers. */
  s1: string;
  /** Floating layers when solid: menus, dialogs, the composer. */
  s2: string;
  sidebar: string;
  border: string;
  /** Primary, secondary and quiet text. */
  t1: string;
  t2: string;
  t3: string;
  accent: string;
  accentHover: string;
  accentPressed: string;
  /** Labels on an accent fill. */
  accentFg: string;
  /** The accent as text: links, the current view. */
  accentText: string;
  working: string;
  workingText: string;
  needs: string;
  needsText: string;
  failed: string;
  failedText: string;
  done: string;
  doneText: string;
  code: string;
  /** "r g b" of the shadow tint; light themes cast a shadow in their own hue. */
  shadow: string;
}

export interface ThemeDefinition {
  name: string;
  light: Palette;
  dark: Palette;
}

export const themeIds = ["ace", "paper", "dusk", "tide", "ember", "moss"] as const;
export type ThemeId = (typeof themeIds)[number];
export const defaultThemeId: ThemeId = "ace";

export const themes: Record<ThemeId, ThemeDefinition> = {
  ace: {
    name: "Ace",
    light: {
      s0: "#FBFBFC",
      s1: "#F2F3F5",
      s2: "#FFFFFF",
      sidebar: "#F5F5F7",
      border: "#E2E3E7",
      t1: "#17181B",
      t2: "#474A52",
      t3: "#60646C",
      accent: "#2A62E3",
      accentHover: "#2256CC",
      accentPressed: "#1C49AF",
      accentFg: "#FFFFFF",
      accentText: "#2458CC",
      working: "#2A62E3",
      workingText: "#2458CC",
      needs: "#C46A0B",
      needsText: "#9C520A",
      failed: "#D63B3B",
      failedText: "#B12B2B",
      done: "#2E8A50",
      doneText: "#23723F",
      code: "#F4F5F7",
      shadow: "24 30 48",
    },
    dark: {
      s0: "#131416",
      s1: "#1B1C1F",
      s2: "#232428",
      sidebar: "#0F1012",
      border: "#2B2D32",
      t1: "#ECEDEF",
      t2: "#B1B4BB",
      t3: "#9A9DA5",
      accent: "#5C8DF0",
      accentHover: "#729DF3",
      accentPressed: "#4D7EE3",
      accentFg: "#0B1530",
      accentText: "#86A9F5",
      working: "#5C8DF0",
      workingText: "#86A9F5",
      needs: "#E9A14C",
      needsText: "#EFB46B",
      failed: "#EE7272",
      failedText: "#F29090",
      done: "#4DBE78",
      doneText: "#73CC94",
      code: "#0E0F11",
      shadow: "0 0 0",
    },
  },
  paper: {
    name: "Paper",
    light: {
      s0: "#FAF9F6",
      s1: "#F1EFEA",
      s2: "#FFFFFD",
      sidebar: "#F4F2ED",
      border: "#E2DED5",
      t1: "#1F1D1A",
      t2: "#4B4842",
      t3: "#67635C",
      accent: "#1E6A4E",
      accentHover: "#195C43",
      accentPressed: "#134A36",
      accentFg: "#FFFFFF",
      accentText: "#1E6A4E",
      working: "#1E6A4E",
      workingText: "#1E6A4E",
      needs: "#B3600F",
      needsText: "#97500C",
      failed: "#C23B2C",
      failedText: "#A53224",
      done: "#5A6A7B",
      doneText: "#4E5D6D",
      code: "#F3F1EC",
      shadow: "48 40 28",
    },
    dark: {
      s0: "#1A1917",
      s1: "#22201D",
      s2: "#2A2825",
      sidebar: "#151412",
      border: "#34312C",
      t1: "#EEEBE4",
      t2: "#BAB4A9",
      t3: "#A7A196",
      accent: "#6FBF98",
      accentHover: "#83CBA8",
      accentPressed: "#5EAD87",
      accentFg: "#0B2318",
      accentText: "#86CBA9",
      working: "#6FBF98",
      workingText: "#86CBA9",
      needs: "#E6A657",
      needsText: "#ECB670",
      failed: "#EC7D6E",
      failedText: "#F19587",
      done: "#95A7BB",
      doneText: "#A9B8C8",
      code: "#141311",
      shadow: "0 0 0",
    },
  },
  dusk: {
    name: "Dusk",
    light: {
      s0: "#FAFAFC",
      s1: "#F1F1F6",
      s2: "#FFFFFF",
      sidebar: "#F4F4F9",
      border: "#E0E0EA",
      t1: "#1A1A24",
      t2: "#464759",
      t3: "#616375",
      accent: "#5753C4",
      accentHover: "#4C48B3",
      accentPressed: "#403C9C",
      accentFg: "#FFFFFF",
      accentText: "#504CBA",
      working: "#5753C4",
      workingText: "#504CBA",
      needs: "#B6620D",
      needsText: "#9A520A",
      failed: "#C93A4C",
      failedText: "#AE2E40",
      done: "#2D7F57",
      doneText: "#246D4A",
      code: "#F3F3F8",
      shadow: "36 32 72",
    },
    dark: {
      s0: "#141419",
      s1: "#1B1B22",
      s2: "#23232C",
      sidebar: "#101015",
      border: "#2C2C37",
      t1: "#ECECF3",
      t2: "#B4B4C6",
      t3: "#9A9AAD",
      accent: "#9693F0",
      accentHover: "#A8A5F4",
      accentPressed: "#8582E2",
      accentFg: "#15132D",
      accentText: "#ABA8F5",
      working: "#9693F0",
      workingText: "#ABA8F5",
      needs: "#E9A250",
      needsText: "#EEB26C",
      failed: "#EF7B89",
      failedText: "#F3929E",
      done: "#5DBE8D",
      doneText: "#78CB9F",
      code: "#0F0F13",
      shadow: "0 0 0",
    },
  },
  tide: {
    name: "Tide",
    light: {
      s0: "#F9FBFB",
      s1: "#EFF3F4",
      s2: "#FFFFFF",
      sidebar: "#F3F6F7",
      border: "#DCE3E6",
      t1: "#142024",
      t2: "#42515A",
      t3: "#58666E",
      accent: "#0D6B75",
      accentHover: "#0A5D66",
      accentPressed: "#084E56",
      accentFg: "#FFFFFF",
      accentText: "#0D6B75",
      working: "#0D6B75",
      workingText: "#0D6B75",
      needs: "#B4600B",
      needsText: "#98510A",
      failed: "#C43C3C",
      failedText: "#AA3030",
      done: "#2E7B4C",
      doneText: "#266A41",
      code: "#F0F4F5",
      shadow: "16 40 48",
    },
    dark: {
      s0: "#10171A",
      s1: "#162024",
      s2: "#1D292E",
      sidebar: "#0C1315",
      border: "#25333A",
      t1: "#E5EEF0",
      t2: "#A8B9BF",
      t3: "#92A2A9",
      accent: "#3FB6C0",
      accentHover: "#57C3CC",
      accentPressed: "#33A4AE",
      accentFg: "#052629",
      accentText: "#5DC5CE",
      working: "#3FB6C0",
      workingText: "#5DC5CE",
      needs: "#E9A04A",
      needsText: "#EEB168",
      failed: "#EE7B7B",
      failedText: "#F29494",
      done: "#5BBF89",
      doneText: "#78CB9D",
      code: "#0B1113",
      shadow: "0 0 0",
    },
  },
  ember: {
    name: "Ember",
    light: {
      s0: "#FBFAF9",
      s1: "#F3F1EE",
      s2: "#FFFFFF",
      sidebar: "#F6F4F1",
      border: "#E4E0DA",
      t1: "#1E1B18",
      t2: "#4C4741",
      t3: "#68625B",
      accent: "#B1522A",
      accentHover: "#9D4723",
      accentPressed: "#853C1D",
      accentFg: "#FFFFFF",
      accentText: "#A04A25",
      working: "#3C6C96",
      workingText: "#355F85",
      needs: "#A86B00",
      needsText: "#885700",
      failed: "#C2363A",
      failedText: "#A52D31",
      done: "#3B7848",
      doneText: "#30673C",
      code: "#F5F3F0",
      shadow: "56 36 20",
    },
    dark: {
      s0: "#171513",
      s1: "#1F1C19",
      s2: "#28241F",
      sidebar: "#12100E",
      border: "#332E28",
      t1: "#F0ECE7",
      t2: "#BFB7AD",
      t3: "#A39B92",
      accent: "#E08A5C",
      accentHover: "#E79C72",
      accentPressed: "#D27B4D",
      accentFg: "#2A1206",
      accentText: "#E99A6F",
      working: "#7FA9D2",
      workingText: "#95B9DC",
      needs: "#E8B24A",
      needsText: "#EDC066",
      failed: "#EE7C74",
      failedText: "#F2958E",
      done: "#6BBE7F",
      doneText: "#86CB97",
      code: "#110F0D",
      shadow: "0 0 0",
    },
  },
  moss: {
    name: "Moss",
    light: {
      s0: "#FAFAF8",
      s1: "#F1F1EC",
      s2: "#FFFFFF",
      sidebar: "#F4F4EF",
      border: "#DEDED5",
      t1: "#1B1D19",
      t2: "#474A42",
      t3: "#62655C",
      accent: "#486A38",
      accentHover: "#3E5C30",
      accentPressed: "#334D28",
      accentFg: "#FFFFFF",
      accentText: "#456635",
      working: "#486A38",
      workingText: "#456635",
      needs: "#A9640F",
      needsText: "#8C530C",
      failed: "#BE3B33",
      failedText: "#A3322B",
      done: "#56667A",
      doneText: "#4A596C",
      code: "#F3F3EF",
      shadow: "36 44 28",
    },
    dark: {
      s0: "#141613",
      s1: "#1B1E1A",
      s2: "#232722",
      sidebar: "#10120F",
      border: "#2B3029",
      t1: "#E9ECE5",
      t2: "#B2B8AA",
      t3: "#9CA295",
      accent: "#9DBE84",
      accentHover: "#AECB98",
      accentPressed: "#8EB075",
      accentFg: "#17210F",
      accentText: "#AFCB99",
      working: "#9DBE84",
      workingText: "#AFCB99",
      needs: "#E3A957",
      needsText: "#E9B870",
      failed: "#EC8077",
      failedText: "#F0988F",
      done: "#8FA6C0",
      doneText: "#A4B7CD",
      code: "#0E100D",
      shadow: "0 0 0",
    },
  },
};

/** Code syntax colours, shared by every theme of a scheme. */
export const syntax: Record<
  Scheme,
  { kw: string; str: string; num: string; fn: string; type: string; com: string }
> = {
  light: {
    kw: "#9A3AAE",
    str: "#2F7A3A",
    num: "#B0560A",
    fn: "#2557C4",
    type: "#0E7280",
    com: "#7A7F88",
  },
  dark: {
    kw: "#D490E6",
    str: "#8FD19B",
    num: "#F0A868",
    fn: "#86ACF6",
    type: "#6CCFD8",
    com: "#7F848D",
  },
};

/** Waiting and not-responding hues: the design leaves them per scheme, not per theme. */
export const sharedStatus: Record<Scheme, { waiting: string; unresponsive: string }> = {
  light: { waiting: "#7A5BD6", unresponsive: "#C2508A" },
  dark: { waiting: "#B49CF5", unresponsive: "#E88BB3" },
};
