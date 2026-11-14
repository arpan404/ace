import { SuitManifest, type SuitProblem } from "@ace/protocol/suits";
import {
  contrastWarnings,
  nearStatus,
  statusDistance,
  statusGap,
  type Palette,
  type PaletteColour,
  type Scheme,
} from "@ace/themes";
import { suitPalette, suitSchemes } from "./palette.ts";

/*
 * Every check a Suit must pass before it can be applied, as problems an agent can act on: the
 * manifest's schema, its fonts' files, and the readability checks the built-in themes pass.
 */

/** Palette short names, as the Suit field a person would change. */
const suitField: Partial<Record<PaletteColour, string>> = {
  s0: "canvas",
  s1: "surface",
  s2: "raised",
  t1: "text",
  t2: "muted",
  t3: "subtle",
  accentPressed: "accentHover",
};
const suitFields = new Set<string>([
  "canvas",
  "sidebar",
  "surface",
  "raised",
  "hover",
  "active",
  "faint",
  "subtle",
  "muted",
  "text",
  "code",
  "accent",
  "accentHover",
  "accentFg",
  "accentText",
]);
const surfaceFields = "canvas, sidebar, surface, raised, hover, active and code";

const fontExtensions = /\.(woff2|woff|ttf|otf)$/i;

export const problem = (
  check: string,
  message: string,
  field: string | null = null,
  scheme: Scheme | null = null,
): SuitProblem => ({ scheme, check, field, message });

/** The parsed manifest, or the problems that stop it parsing. */
export function parseManifest(
  id: string,
  text: string,
): { manifest: SuitManifest | undefined; problems: SuitProblem[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "not JSON";
    const problems = [problem("schema", `suit.json is not valid JSON: ${reason}`, "suit.json")];
    return { manifest: undefined, problems };
  }
  const parsed = SuitManifest.safeParse(json);
  if (!parsed.success)
    return {
      manifest: undefined,
      problems: parsed.error.issues.map((issue) => {
        const head = issue.path[0];
        const scheme = head === "light" || head === "dark" ? head : null;
        const field = issue.path.length ? issue.path.join(".") : null;
        return problem("schema", issue.message, field, scheme);
      }),
    };
  const problems: SuitProblem[] = [];
  if (parsed.data.id !== id)
    problems.push(problem("schema", `id is "${parsed.data.id}" but the folder is "${id}"`, "id"));
  if (suitSchemes(parsed.data).length === 0)
    problems.push(problem("schema", "set a light or a dark palette (or both)", null));
  return { manifest: parsed.data, problems };
}

/** Fonts that name a file the folder doesn't have, or a file that isn't a font. */
export function fontProblems(manifest: SuitManifest, files: ReadonlySet<string>): SuitProblem[] {
  const problems: SuitProblem[] = [];
  for (const role of ["ui", "prose", "mono"] as const) {
    const font = manifest.fonts?.[role];
    if (!font || !("asset" in font)) continue;
    if (!files.has(font.asset))
      problems.push(
        problem("asset", `fonts.${role} names ${font.asset}, which is missing`, font.asset),
      );
    else if (!fontExtensions.test(font.asset))
      problems.push(
        problem("asset", `fonts.${role} must be a .woff2, .woff, .ttf or .otf file`, font.asset),
      );
  }
  return problems;
}

function contrastProblems(palette: Palette, scheme: Scheme): SuitProblem[] {
  return contrastWarnings(palette, scheme).map((warning) => {
    const field = warning.key ? (suitField[warning.key] ?? warning.key) : null;
    const reads = `${warning.label} reads at ${warning.ratio.toFixed(2)}:1, under ${warning.minimum}:1`;
    // Status words and project tints aren't the Suit's to set; the surfaces under them are.
    const fix =
      field && suitFields.has(field) ? `change ${field}` : `change the surfaces (${surfaceFields})`;
    return problem(
      "contrast",
      `${reads}; ${fix}`,
      field && suitFields.has(field) ? field : null,
      scheme,
    );
  });
}

function accentProblems(manifest: SuitManifest, palette: Palette, scheme: Scheme): SuitProblem[] {
  const accent = manifest[scheme]?.accent;
  if (accent === undefined) return [];
  const derived = (["accentHover", "accentFg", "accentText"] as const).some(
    (field) => manifest[scheme]?.[field] === undefined,
  );
  const close = derived
    ? nearStatus(accent, scheme, palette)
    : statusGap(accent, palette, scheme) < statusDistance;
  return close
    ? [
        problem(
          "accent-fit",
          `${accent} is too close to a status colour (working, needs you, done, failed, waiting); turn its hue away from blue, amber, green, red and violet`,
          "accent",
          scheme,
        ),
      ]
    : [];
}

/** Glass whose text can't read over busy backdrops at any thinness. */
function glassProblems(palette: Palette, scheme: Scheme): SuitProblem[] {
  if (!palette.material.glass || palette.glassTint < 1) return [];
  return [
    problem(
      "glass-floor",
      "text can't read on glass over busy backdrops at any thinness; set glass to null or move raised and text further apart",
      "glass",
      scheme,
    ),
  ];
}

/** The readability checks for every scheme the Suit has. */
export function readabilityProblems(manifest: SuitManifest): SuitProblem[] {
  return suitSchemes(manifest).flatMap((scheme) => {
    const palette = suitPalette(manifest, scheme);
    return [
      ...contrastProblems(palette, scheme),
      ...accentProblems(manifest, palette, scheme),
      ...glassProblems(palette, scheme),
    ];
  });
}
