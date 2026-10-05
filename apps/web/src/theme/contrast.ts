import { tokenNames, type ThemeTokens, type TokenName } from "./tokens.ts";

type Rgb = readonly [number, number, number];

const hexChannel = (digits: string, at: number) => Number.parseInt(digits.slice(at, at + 2), 16);

/** Opaque hex or rgb() colours only; translucent values have no fixed contrast. */
export function parseOpaqueColor(value: string | undefined): Rgb | undefined {
  if (!value) return undefined;
  const text = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex?.[1]) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [hexChannel(digits, 0), hexChannel(digits, 2), hexChannel(digits, 4)];
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[/,]\s*([\d.]+))?\s*\)$/i.exec(text);
  if (!rgb) return undefined;
  if (rgb[4] !== undefined && Number(rgb[4]) < 1) return undefined;
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
}

function linear(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance([r, g, b]: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2 contrast ratio between two opaque colours. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export interface ContrastWarning {
  token: TokenName;
  label: string;
  ratio: number;
  minimum: number;
}

const checks: readonly { token: TokenName; against: TokenName; minimum: number; label: string }[] =
  [
    { token: "--foreground", against: "--background", minimum: 4.5, label: "Text on background" },
    { token: "--muted-foreground", against: "--background", minimum: 4.5, label: "Secondary text" },
    { token: "--subtle-foreground", against: "--background", minimum: 4.5, label: "Subtle text" },
    { token: "--accent-theme", against: "--background", minimum: 3, label: "Accent" },
    {
      token: "--primary-foreground",
      against: "--primary",
      minimum: 4.5,
      label: "Primary button label",
    },
    { token: "--destructive", against: "--background", minimum: 3, label: "Destructive" },
    { token: "--status-needs-you", against: "--background", minimum: 3, label: "Status needs you" },
    { token: "--status-working", against: "--background", minimum: 3, label: "Status working" },
    { token: "--status-waiting", against: "--background", minimum: 3, label: "Status waiting" },
    { token: "--status-failed", against: "--background", minimum: 3, label: "Status failed" },
    { token: "--status-done", against: "--background", minimum: 3, label: "Status done" },
    {
      token: "--status-unresponsive",
      against: "--background",
      minimum: 3,
      label: "Status unresponsive",
    },
    // A badge's letters are drawn in its tint.
    ...tokenNames
      .filter((token) => token.startsWith("--project-"))
      .map((token) => ({
        token,
        against: "--background" as const,
        minimum: 4.5,
        label: `Project tint ${token.slice("--project-".length)}`,
      })),
  ];

/** WCAG checks the Theme editor lists above the token groups. */
export function contrastWarnings(tokens: ThemeTokens): ContrastWarning[] {
  return checks.flatMap((check) => {
    const color = parseOpaqueColor(tokens[check.token]);
    const base = parseOpaqueColor(tokens[check.against]);
    if (!color || !base) return [];
    const ratio = contrastRatio(color, base);
    return ratio < check.minimum
      ? [{ token: check.token, label: check.label, ratio, minimum: check.minimum }]
      : [];
  });
}
