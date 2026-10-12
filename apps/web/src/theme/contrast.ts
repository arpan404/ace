import { contrastRatio, parseOpaqueColor, worstContrast } from "./colour.ts";
import type { Palette, Scheme } from "./palettes.ts";
import { paletteSurfaces } from "./surfaces.ts";
import { projectTintCount, themeTokens } from "./tokens.ts";

export { contrastRatio, parseOpaqueColor, type Rgb } from "./colour.ts";

export interface ContrastWarning {
  label: string;
  ratio: number;
  minimum: number;
}

/** Text that must read at AA (4.5:1) wherever it is drawn (`paletteSurfaces`). */
const textChecks: readonly { key: keyof Palette; label: string }[] = [
  { key: "t1", label: "Text" },
  { key: "t2", label: "Secondary text" },
  { key: "t3", label: "Quiet text" },
  { key: "accentText", label: "Links" },
  { key: "workingText", label: "Working words" },
  { key: "needsText", label: "Needs-you words" },
  { key: "failedText", label: "Failed words" },
  { key: "doneText", label: "Done words" },
];

/** Marks with no text of their own (dots, rings, fills) need 3:1 against the page. */
const markChecks: readonly { key: keyof Palette; label: string }[] = [
  { key: "faint", label: "Faint icons" },
  { key: "accent", label: "Accent" },
  { key: "working", label: "Working mark" },
  { key: "needs", label: "Needs-you mark" },
  { key: "failed", label: "Failed mark" },
  { key: "done", label: "Done mark" },
];

/** Labels on an accent fill, in each of its states. */
const fillChecks: readonly { key: keyof Palette; label: string }[] = [
  { key: "accent", label: "Label on accent" },
  { key: "accentHover", label: "Label on hovered accent" },
  { key: "accentPressed", label: "Label on pressed accent" },
];

/** Every WCAG AA failure in one theme's light or dark palette; empty when it passes. */
export function contrastWarnings(palette: Palette, scheme: Scheme): ContrastWarning[] {
  const surfaces = paletteSurfaces(palette, scheme).map((surface) => surface.rgb);
  const warnings: ContrastWarning[] = [];
  const check = (label: string, ratio: number, minimum: number) => {
    if (ratio < minimum) warnings.push({ label, ratio, minimum });
  };
  const tokens: Record<string, string | undefined> = themeTokens(palette, scheme);
  const projectTints = Array.from({ length: projectTintCount }, (_, index) => ({
    label: `Project tint ${index + 1}`,
    value: tokens[`--project-${index + 1}`],
  }));
  for (const { label, value } of [
    ...textChecks.map((entry) => ({ label: entry.label, value: palette[entry.key] })),
    ...projectTints,
  ]) {
    const colour = parseOpaqueColor(value);
    if (colour) check(label, worstContrast(colour, surfaces), 4.5);
  }
  const page = parseOpaqueColor(palette.s0);
  for (const { key, label } of markChecks) {
    const colour = parseOpaqueColor(palette[key]);
    if (colour && page) check(label, contrastRatio(colour, page), 3);
  }
  const onFill = parseOpaqueColor(palette.accentFg);
  for (const { key, label } of fillChecks) {
    const fill = parseOpaqueColor(palette[key]);
    if (fill && onFill) check(label, contrastRatio(onFill, fill), 4.5);
  }
  return warnings;
}
