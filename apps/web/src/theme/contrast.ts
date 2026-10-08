import { contrastRatio, parseOpaqueColor, worstContrast } from "./colour.ts";
import { themeSurfaces } from "./surfaces.ts";
import { tokenNames, type ThemeTokens, type TokenName } from "./tokens.ts";

export { contrastRatio, parseOpaqueColor, type Rgb } from "./colour.ts";

export interface ContrastWarning {
  token: TokenName;
  label: string;
  ratio: number;
  minimum: number;
}

const checks: readonly { token: TokenName; against: TokenName; minimum: number; label: string }[] =
  [
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
  ];

/**
 * Text that must read at AA wherever it is drawn: on the page, popovers, the sidebar and
 * reading column, floating glass at both intensity extremes, and selected rows (`themeSurfaces`).
 * A project badge draws its letters in its tint.
 */
const surfaceChecks: readonly { token: TokenName; label: string }[] = [
  { token: "--foreground", label: "Text" },
  { token: "--muted-foreground", label: "Secondary text" },
  { token: "--subtle-foreground", label: "Subtle text" },
  ...tokenNames
    .filter((token) => token.startsWith("--project-"))
    .map((token) => ({ token, label: `Project tint ${token.slice("--project-".length)}` })),
];

/** WCAG checks the Theme editor lists above the token groups. */
export function contrastWarnings(tokens: ThemeTokens): ContrastWarning[] {
  const surfaces = themeSurfaces(tokens).map((surface) => surface.rgb);
  const onSurfaces = surfaceChecks.flatMap(({ token, label }) => {
    const color = parseOpaqueColor(tokens[token]);
    if (!color || surfaces.length === 0) return [];
    const ratio = worstContrast(color, surfaces);
    return ratio < 4.5 ? [{ token, label, ratio, minimum: 4.5 }] : [];
  });
  return [...onSurfaces, ...pairs(tokens)];
}

function pairs(tokens: ThemeTokens): ContrastWarning[] {
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
