import { protectedSuitParts, suitRegions, type SuitRegion } from "@ace/protocol/suit-parts";
import type { SuitDetail, SuitManifest } from "@ace/protocol/suits";
import { clampReveal, revealCeiling } from "@ace/suits";
import type { Palette } from "@ace/themes";

/*
 * Where a Suit's own CSS sits in the cascade (ADR 0150, "suit.css" and "Guard"). ace's layers
 * come first, then `@layer suit` (region backgrounds, then the daemon-sanitised suit.css), then
 * ace's `@layer guard`, which keeps the state of an agent readable whatever the Suit says. The
 * daemon refuses `!important` in suit.css, so a normal declaration in the guard always wins over
 * the Suit's. Pure: strings in, strings out.
 */

/** Tailwind's layers, then the Suit's, then the guard. Repeating the order is harmless. */
export const suitLayerOrder = "@layer theme, base, components, utilities, suit, guard;";

/** What a region reads from `--suit-<region>-<name>`, and the property it sets. */
const regionProperties = [
  ["background", "background"],
  ["border", "border"],
  ["shadow", "box-shadow"],
  ["backdrop-filter", "backdrop-filter"],
] as const;

/**
 * Region rules for the custom properties the Suit's CSS sets. A region only reads a property the
 * Suit names, so an unset one never blanks ace's own background.
 */
export function regionRules(id: string, css: string): string[] {
  const rules: string[] = [];
  for (const region of suitRegions) {
    const declarations = regionProperties.flatMap(([name, property]) => {
      const variable = `--suit-${region}-${name}`;
      return new RegExp(`${variable}\\s*:`).test(css) ? [`${property}:var(${variable})`] : [];
    });
    if (declarations.length > 0)
      rules.push(`[data-suit="${id}"] [data-part="${region}"]{${declarations.join(";")}}`);
  }
  return rules;
}

/**
 * The Suit's stylesheet layer: region backgrounds in a sub-layer the Suit's own rules win over,
 * then suit.css as the daemon sanitised it. Empty without suit.css.
 */
export function suitLayerSheet(detail: Pick<SuitDetail, "css" | "manifest">): string {
  const css = detail.css ?? "";
  if (css === "") return "";
  const regions = regionRules(detail.manifest.id, css);
  return [
    suitLayerOrder,
    regions.length > 0 ? `@layer suit.regions{${regions.join("\n")}}` : "",
    `@layer suit{\n${css}\n}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const part = (name: string) => `[data-part="${name}"]`;
const guarded = `:is(${protectedSuitParts.map(part).join(",")})`;
const statuses = ["working", "waiting", "done", "failed"] as const;

/**
 * ace's guard (ADR 0150): on the approval strip, the Working line, question cards and status
 * icons, whatever a Suit says, they stay shown at full strength, keep a minimum size and take
 * clicks, status icons keep ace's status colours, and every part keeps ace's focus ring.
 *
 * Motion on these parts (animation, transition, transform) is refused at the source: the daemon
 * drops it from suit.css. The guard leaves it alone so ace's own spinners keep turning.
 */
export const suitGuardSheet = [
  suitLayerOrder,
  "@layer guard{",
  `[data-suit] ${guarded}{visibility:visible;opacity:1;filter:none;mix-blend-mode:normal;clip-path:none;mask:none;content-visibility:visible;min-width:6px;min-height:6px}`,
  `[data-suit] :is(${part("approval-strip")},${part("question-card")}){pointer-events:auto;min-height:1lh}`,
  ...statuses.map(
    (state) =>
      `[data-suit] ${part("status-icon")}[data-state="${state}"]{color:var(--status-${state})}`,
  ),
  `[data-suit] [data-part]:focus-visible:not(${part("composer-input")}){outline:2px solid color-mix(in oklab, var(--ring) 70%, transparent);outline-offset:2px}`,
  "}",
].join("\n");

/** The surface each region's text sits on, for the reveal's readability ceiling. */
const regionSurface = (palette: Palette, region: SuitRegion): string =>
  region === "transcript" ? palette.s0 : region === "composer" ? palette.s1 : palette.sidebar;

/**
 * `--suit-<region>-reveal` for every region in one scheme: the Suit's `reveal` held under what
 * keeps that region's text readable over any backdrop, or ace's default look when unset.
 */
export function revealDeclarations(
  manifest: Pick<SuitManifest, "reveal">,
  palette: Palette,
): Record<string, string> {
  const declarations: Record<string, string> = {};
  for (const region of suitRegions) {
    const ceiling = revealCeiling({ text: palette.t1, surface: regionSurface(palette, region) });
    declarations[`--suit-${region}-reveal`] = String(clampReveal(manifest, region, ceiling));
  }
  return declarations;
}
