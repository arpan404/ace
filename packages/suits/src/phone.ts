import type { SuitDetail, SuitFont, SuitSummary } from "@ace/protocol/suits";
import { phoneColoursOf, phoneColourWarnings, type PhoneColours, type Scheme } from "@ace/themes";
import { suitDensity, suitPalette, suitSchemeFor, suitSchemes } from "./palette.ts";

/*
 * A Suit as a phone applies it (ADR 0150: "iPhone and Android apply colours, fonts and shape
 * through @ace/design-tokens; scenes show as a still frame"). The colours are the Suit's palette
 * over its base, mapped to the phone's colour roles exactly as a built-in theme is; status,
 * needs-you, approval, Working and danger colours are not roles, so they stay ace's. suit.css,
 * layout, ornaments and live scenes never reach a phone. Pure.
 */

const schemes: readonly Scheme[] = ["light", "dark"];

/** A font slot as a phone reads it: a bundled file to register, else installed families in order. */
export interface PhoneSuitFont {
  /** `assets/…` path of a bundled font file, or null for installed families. */
  asset: string | null;
  /** Installed family names to try in order; the system font when none is installed. */
  families: string[];
}

export interface PhoneSuit {
  id: string;
  name: string;
  description: string;
  contentHash: string;
  /** The schemes the Suit has; a one-scheme Suit draws that scheme in both. */
  schemes: Scheme[];
  /** The phone's colour roles per scheme the phone may run in. */
  colours: Record<Scheme, PhoneColours>;
  fonts: { ui: PhoneSuitFont | null; prose: PhoneSuitFont | null; mono: PhoneSuitFont | null };
  /** Multiplies the phone's fixed corner radii; capsules and concentric shapes stay as they are. */
  radius: number;
  /** Hairline width in points. */
  border: number;
  /** Overrides the device's density while the Suit shows; null keeps it. */
  density: "comfortable" | "compact" | null;
  /** The still drawn behind the inbox and transcript, per scheme: an `assets/…` path or null. */
  stills: Record<Scheme, string | null>;
  /** Why this phone won't show it; null when it can. */
  unavailable: string | null;
}

/** A Suit in the phone's Look grid, before it is read. */
export interface PhoneSuitRow {
  id: string;
  name: string;
  description: string;
  contentHash: string;
  schemes: Scheme[];
  /** Why it can't be picked; null when it can. */
  unavailable: string | null;
}

/** Generic CSS families, which a phone answers with its system font anyway. */
const generic = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "-apple-system",
  "blinkmacsystemfont",
]);

/** A CSS system stack as family names, quotes taken off and generic keywords dropped. */
export function stackFamilies(stack: string): string[] {
  return stack
    .split(",")
    .map((part) =>
      part
        .trim()
        .replace(/^(["'])(.*)\1$/, "$2")
        .trim(),
    )
    .filter((family) => family.length > 0 && !generic.has(family.toLowerCase()));
}

const bundled = /\.(woff2?|ttf|otf)$/i;

function phoneFont(font: SuitFont | undefined): PhoneSuitFont | null {
  if (!font) return null;
  if ("asset" in font)
    return bundled.test(font.asset) ? { asset: font.asset, families: [font.family] } : null;
  const families = stackFamilies(font.system);
  return families.length > 0 ? { asset: null, families } : null;
}

/** The first problem the daemon found, as the reason a Suit can't be picked. */
function problemReason(summary: Pick<SuitSummary, "problems">): string | null {
  const first = summary.problems[0];
  if (!first) return null;
  const more = summary.problems.length - 1;
  return more > 0 ? `${first.message} (and ${more} more)` : first.message;
}

export function phoneSuitRow(summary: SuitSummary): PhoneSuitRow {
  return {
    id: summary.id,
    name: summary.name,
    description: summary.description,
    contentHash: summary.contentHash,
    schemes: [...summary.schemes],
    unavailable: problemReason(summary),
  };
}

/** Why the colours won't read on a phone's surfaces, when they won't. */
function colourReason(
  colours: Record<Scheme, PhoneColours>,
  has: readonly Scheme[],
): string | null {
  for (const scheme of has) {
    const failure = phoneColourWarnings(colours[scheme])[0];
    if (failure)
      return `Its ${failure.label} reads at ${failure.ratio.toFixed(1)}:1 in ${scheme} on this phone; it needs ${failure.minimum}:1.`;
  }
  return null;
}

/** The Suit as a phone applies it, with the reason it won't when it won't. */
export function phoneSuit(detail: Pick<SuitDetail, "summary" | "manifest">): PhoneSuit {
  const { summary, manifest } = detail;
  const has = suitSchemes(manifest);
  const colours = Object.fromEntries(
    schemes.map((scheme) => [scheme, phoneColoursOf(suitPalette(manifest, scheme))]),
  ) as Record<Scheme, PhoneColours>;
  const still = (scheme: Scheme) => {
    const drawn = manifest.thumbnail?.[suitSchemeFor(manifest, scheme)];
    return drawn ?? manifest.thumbnail?.light ?? manifest.thumbnail?.dark ?? null;
  };
  return {
    id: summary.id,
    name: summary.name,
    description: summary.description,
    contentHash: summary.contentHash,
    schemes: has,
    colours,
    fonts: {
      ui: phoneFont(manifest.fonts?.ui),
      prose: phoneFont(manifest.fonts?.prose),
      mono: phoneFont(manifest.fonts?.mono),
    },
    radius: manifest.shape?.radius ?? 1,
    border: manifest.shape?.border ?? 1,
    density: suitDensity(manifest) ?? null,
    stills: { light: still("light"), dark: still("dark") },
    unavailable:
      has.length === 0
        ? "It has no light or dark colours."
        : (problemReason(summary) ?? colourReason(colours, has)),
  };
}
