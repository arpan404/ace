import type { Scheme } from "./types.ts";

/** A file type's tone (`FileTone` in `@ace/ui-core/file-types`). */
export type FileToneColour =
  | "blue"
  | "sky"
  | "teal"
  | "green"
  | "yellow"
  | "orange"
  | "red"
  | "pink"
  | "purple";

/**
 * The tones file-type marks are drawn in, the same in every theme of a scheme: brand-ish hues so
 * a TypeScript file reads apart from a Rust one at a glance. They are marks, never status: each
 * file type also has its own outline, so the colour never carries the meaning alone. Each needs
 * 3:1 against the surfaces a file row sits on, its hover and the selected row
 * (readability.test.ts). Grey types (a plain file, a lockfile) take the row's own ink instead. The web draws them as `--file-*`; a Suit may set its own.
 */
export const fileToneColours: Record<Scheme, Record<FileToneColour, string>> = {
  dark: {
    blue: "#6FA6F2",
    sky: "#52BEDC",
    teal: "#45C0A2",
    green: "#8CC56A",
    yellow: "#E2BE4C",
    orange: "#EE9152",
    red: "#EF7470",
    pink: "#E584BF",
    purple: "#AE92EE",
  },
  light: {
    blue: "#2F66C4",
    sky: "#117A91",
    teal: "#117C66",
    green: "#3B7A22",
    yellow: "#866300",
    orange: "#B0520E",
    red: "#BE3936",
    pink: "#AE347B",
    purple: "#7650C6",
  },
};
