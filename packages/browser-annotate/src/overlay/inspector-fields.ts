/** The style inspector's rows, in the order the panel shows them. */
export type FieldKind = "color" | "number" | "font" | "weight" | "length";
export interface StyleField {
  kind: FieldKind;
  label: string;
  property: string;
  /** Arrow-key step for number-like values; Shift multiplies it by ten. */
  step?: number;
}
export interface SidesField {
  kind: "sides";
  label: string;
  /** `padding` or `margin`; the four longhands are edited one by one. */
  property: string;
}
export type InspectorField = StyleField | SidesField;

export const inspectorFields: readonly InspectorField[] = [
  { kind: "color", label: "Text color", property: "color" },
  { kind: "color", label: "Background", property: "background-color" },
  { kind: "number", label: "Opacity", property: "opacity", step: 0.05 },
  { kind: "font", label: "Font", property: "font-family" },
  { kind: "length", label: "Font size", property: "font-size", step: 1 },
  { kind: "weight", label: "Font weight", property: "font-weight" },
  { kind: "length", label: "Border radius", property: "border-radius", step: 1 },
  { kind: "color", label: "Border color", property: "border-color" },
  { kind: "length", label: "Border width", property: "border-width", step: 1 },
  { kind: "length", label: "Width", property: "width", step: 1 },
  { kind: "length", label: "Height", property: "height", step: 1 },
  { kind: "sides", label: "Padding", property: "padding" },
  { kind: "sides", label: "Margin", property: "margin" },
];

export const sides = ["top", "right", "bottom", "left"] as const;

export const fontWeights = ["100", "200", "300", "400", "500", "600", "700", "800", "900"];

/** Generic stacks offered for every page, before the fonts the page itself loaded. */
const commonFonts = [
  "system-ui, sans-serif",
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  "Inter, sans-serif",
  "Helvetica, Arial, sans-serif",
  "Georgia, serif",
  '"Times New Roman", Times, serif',
  "ui-monospace, Menlo, Consolas, monospace",
  "sans-serif",
  "serif",
  "monospace",
];

/** The current stack first, then the page's own font families, then common stacks. */
export function fontChoices(current: string): string[] {
  const loaded = new Set<string>();
  try {
    document.fonts.forEach((face) => {
      const family = face.family.replace(/^["']|["']$/g, "").trim();
      if (family) loaded.add(/\s/.test(family) ? `"${family}"` : family);
    });
  } catch {
    /* No FontFaceSet: the common stacks still apply. */
  }
  return [...new Set([current, ...loaded, ...commonFonts].filter(Boolean))].slice(0, 40);
}

/** `#rrggbb` for an `rgb()`/`rgba()` computed colour, for the native colour picker. */
export function hexOf(color: string): string | undefined {
  const match = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(color);
  if (!match) return undefined;
  return `#${match
    .slice(1, 4)
    .map((part) => Number(part).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Step the first number in `value` (keeping its unit), as arrow keys do in devtools. */
export function stepValue(value: string, delta: number): string | undefined {
  const match = /^(-?\d*\.?\d+)(.*)$/.exec(value.trim());
  if (!match) return undefined;
  const next = Math.round((Number(match[1]) + delta) * 1000) / 1000;
  return `${next}${match[2] ?? ""}`;
}
