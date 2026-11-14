import { contrastRatio, parseOpaqueColor, worstContrast } from "./colour.ts";
import { projectTints } from "./projects.ts";
import { paletteSurfaces } from "./surfaces.ts";
import type { Palette, PaletteColour, Scheme } from "./types.ts";

/*
 * The WCAG AA checks every theme passes, built in or made as a Suit (ADR 0150): text on every
 * surface it can sit on (`paletteSurfaces`), marks against the page, labels on the accent fill.
 */

export interface ContrastWarning {
  /** The palette field that falls short; null for a project tint, which no palette sets. */
  key: PaletteColour | null;
  label: string;
  ratio: number;
  minimum: number;
}

/** Text that must read at AA (4.5:1) wherever it is drawn (`paletteSurfaces`). */
const textChecks: readonly { key: PaletteColour; label: string }[] = [
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
const markChecks: readonly { key: PaletteColour; label: string }[] = [
  { key: "faint", label: "Faint icons" },
  { key: "accent", label: "Accent" },
  { key: "working", label: "Working mark" },
  { key: "needs", label: "Needs-you mark" },
  { key: "failed", label: "Failed mark" },
  { key: "done", label: "Done mark" },
];

/** Labels on an accent fill, in each of its states. */
const fillChecks: readonly { key: PaletteColour; label: string }[] = [
  { key: "accent", label: "Label on accent" },
  { key: "accentHover", label: "Label on hovered accent" },
  { key: "accentPressed", label: "Label on pressed accent" },
];

/** Every WCAG AA failure in one theme's light or dark palette; empty when it passes. */
export function contrastWarnings(palette: Palette, scheme: Scheme): ContrastWarning[] {
  const surfaces = paletteSurfaces(palette, scheme).map((surface) => surface.rgb);
  const warnings: ContrastWarning[] = [];
  const check = (key: PaletteColour | null, label: string, ratio: number, minimum: number) => {
    if (ratio < minimum) warnings.push({ key, label, ratio, minimum });
  };
  const texts = [
    ...textChecks.map((entry) => ({ ...entry, value: palette[entry.key] })),
    ...projectTints(scheme).map((value, index) => ({
      key: null,
      label: `Project tint ${index + 1}`,
      value,
    })),
  ];
  for (const { key, label, value } of texts) {
    const colour = parseOpaqueColor(value);
    if (colour) check(key, label, worstContrast(colour, surfaces), 4.5);
  }
  const page = parseOpaqueColor(palette.s0);
  for (const { key, label } of markChecks) {
    const colour = parseOpaqueColor(palette[key]);
    if (colour && page) check(key, label, contrastRatio(colour, page), 3);
  }
  const onFill = parseOpaqueColor(palette.accentFg);
  for (const { key, label } of fillChecks) {
    const fill = parseOpaqueColor(palette[key]);
    if (fill && onFill) check(key, label, contrastRatio(onFill, fill), 4.5);
  }
  return warnings;
}
