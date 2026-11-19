import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { flatten } from "./brand-marks/flatten.ts";

/*
 * Turns the brand marks ace shows for providers, ACP agents and model families into plain path
 * data in `packages/ui-core/src/brand-art/`. The marks come from LobeHub Icons
 * (`@lobehub/icons-static-svg`, MIT, see NOTICE), except the ones in `official` below, which come
 * unmodified from their maker's own brand kit and are kept in `scripts/brand-marks/`; nothing
 * else is read. Each brand becomes its own module so the web app loads a mark only when one is on
 * screen.
 *
 *   node scripts/provider-icons.ts
 *
 * To add a brand: add it to `brands` below, run this, then map it in
 * `packages/ui-core/src/provider-icons.ts`.
 */

/**
 * Brand key → how its colour variant is made. `color` uses LobeHub's full-colour SVG; marks
 * without one (Cursor, OpenCode…) are black-and-white brands and draw in the text colour.
 * `adapt` lists fills of the colour SVG that are the brand's black or white and so follow the
 * text colour (Kimi's white K would vanish on a light surface); `drop` lists fills that only
 * paint a backdrop tile, so the mark's cutouts show the surface behind it in every theme.
 */
const brands: Record<string, { color: boolean; adapt?: string[]; drop?: string[] }> = {
  amp: { color: true },
  // The colour SVG needs masks and filters; the mono mark stays.
  antigravity: { color: false },
  claude: { color: true },
  cline: { color: false },
  codebuddy: { color: true },
  cursor: { color: false },
  deepseek: { color: true },
  devin: { color: true },
  gemini: { color: true },
  geminicli: { color: true },
  // GitHub's Invertocat; a one-colour brand.
  github: { color: false },
  gemma: { color: true },
  githubcopilot: { color: false },
  goose: { color: false },
  grok: { color: false },
  junie: { color: true },
  kilocode: { color: false },
  kimi: { color: true, adapt: ["#fff"] },
  langchain: { color: true },
  meta: { color: true },
  minimax: { color: true },
  mistral: { color: true },
  openrouter: { color: false },
  ollama: { color: false },
  opencode: { color: false },
  pi: { color: false },
  qoder: { color: true },
  qwen: { color: true },
  snowflake: { color: true },
  zai: { color: false },
};

/**
 * Marks drawn from their maker's brand kit instead of LobeHub, kept byte-for-byte as downloaded
 * and read by `brand-marks/flatten.ts`. The kits pad a mark with clear space, so `viewBox` crops
 * to the mark's own bounds and it fills its box like the LobeHub marks.
 *
 * `mono` is the file the one-colour variant comes from: its `ink` fills are the brand's black (or
 * its colours, flattened) and draw in the text colour so the mark follows every theme; `knockout`
 * fills only paint a cutout, so they're left out and the surface shows through. Any other fill is
 * an error. `color`, when the brand has colours, is the file drawn in them as it is.
 */
interface OfficialMark {
  source: string;
  viewBox: string;
  mono: { file: string; ink: string[]; knockout?: string[] };
  color?: string;
}
const official: Record<string, OfficialMark> = {
  // The OpenAI Blossom, the mark ChatGPT and Codex carry, from OpenAI's brand guidelines
  // (https://openai.com/brand/): https://cdn.openai.com/brand/openai-logos.zip, file
  // OpenAI-logos/SVGs/OAI_OpenAI-Blossom_Black.svg. Its outline spans 180.5 to 535.17 on both
  // axes of the kit's 716 square.
  openai: {
    source:
      "OpenAI's brand kit https://cdn.openai.com/brand/openai-logos.zip " +
      "(OAI_OpenAI-Blossom_Black.svg, from https://openai.com/brand/)",
    viewBox: "180.49 180.49 354.69 354.69",
    mono: { file: "openai-blossom.svg", ink: ["black"] },
  },
  // Bitbucket's tile from Atlassian's own logo package, @atlaskit/logo 23.3.1 (Apache-2.0):
  // the `svg` (brand colours) and `customThemeSvg` (one colour, the bucket cut out of the tile)
  // strings of dist/esm/artifacts/logo-components/bitbucket/icon.js, written out unchanged.
  bitbucket: {
    source:
      "Atlassian's @atlaskit/logo 23.3.1 https://www.npmjs.com/package/@atlaskit/logo " +
      "(bitbucket/icon, Apache-2.0)",
    viewBox: "0 0 24 24",
    mono: { file: "bitbucket-icon-themed.svg", ink: ["currentColor"] },
    color: "bitbucket-icon.svg",
  },
  // Forgejo's logo by Caesar Schinas, CC BY-SA 4.0, from the project's branding page
  // (https://codeberg.org/forgejo/governance/src/branch/main/branding#logo): logo/forgejo.svg
  // and logo/forgejo-monochrome.svg. Its strokes span 38.5 to 173.5 across, 0.5 to 211.5 down.
  forgejo: {
    source:
      "Forgejo's branding https://codeberg.org/forgejo/governance/src/branch/main/branding " +
      "(logo/forgejo.svg, logo/forgejo-monochrome.svg, by Caesar Schinas, CC BY-SA 4.0)",
    viewBox: "38.5 0.5 135 211",
    mono: { file: "forgejo-monochrome.svg", ink: ["currentColor"] },
    color: "forgejo.svg",
  },
  // GitBucket's mark from its own repository (Apache-2.0):
  // https://github.com/gitbucket/gitbucket/blob/master/src/main/webapp/assets/common/images/gitbucket.svg
  gitbucket: {
    source:
      "GitBucket https://github.com/gitbucket/gitbucket " +
      "(src/main/webapp/assets/common/images/gitbucket.svg, Apache-2.0)",
    viewBox: "0 0 316 329",
    mono: { file: "gitbucket.svg", ink: ["#303030"] },
  },
  // Gitea's teacup from its own repository (MIT): https://github.com/go-gitea/gitea/blob/main/assets/logo.svg.
  // The white teabag is a cutout in the one-colour mark.
  gitea: {
    source: "Gitea https://github.com/go-gitea/gitea (assets/logo.svg, MIT)",
    viewBox: "5 139 630 357",
    mono: { file: "gitea-logo.svg", ink: ["#609926"], knockout: ["#FFFFFF"] },
    color: "gitea-logo.svg",
  },
  // The GitLab tanuki as GitLab's own app draws it (MIT outside ee/):
  // https://gitlab.com/gitlab-org/gitlab/-/blob/master/app/views/shared/_logo.svg
  gitlab: {
    source: "GitLab https://gitlab.com/gitlab-org/gitlab (app/views/shared/_logo.svg, MIT)",
    viewBox: "0 0 25 24",
    mono: { file: "gitlab-tanuki.svg", ink: ["#E24329", "#FC6D26", "#FCA326"] },
    color: "gitlab-tanuki.svg",
  },
};
const officialMarks = join(import.meta.dirname, "brand-marks");

const require = createRequire(import.meta.url);
const icons = join(dirname(require.resolve("@lobehub/icons-static-svg/package.json")), "icons");
const version = (
  JSON.parse(readFileSync(join(icons, "..", "package.json"), "utf8")) as { version: string }
).version;
const out = join(import.meta.dirname, "..", "packages", "ui-core", "src", "brand-art");

interface Gradient {
  type: "linear" | "radial";
  attributes: Record<string, string>;
  stops: { offset: string; color: string; opacity?: number }[];
}

interface Path {
  d: string;
  fill?: string;
  gradient?: Gradient;
  fillRule?: "evenodd" | "nonzero";
  clipRule?: "evenodd" | "nonzero";
  opacity?: number;
}

const attributes = (tag: string): Map<string, string> =>
  new Map(
    [...tag.matchAll(/([a-zA-Z][a-zA-Z0-9:-]*)="([^"]*)"/g)].map((m) => [m[1] ?? "", m[2] ?? ""]),
  );

const rule = (value: string | undefined, file: string): "evenodd" | "nonzero" | undefined => {
  if (value === undefined) return undefined;
  if (value === "evenodd" || value === "nonzero") return value;
  throw new Error(`${file}: unexpected fill rule ${value}`);
};

const gradientAttributes = new Set([
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "fx",
  "fy",
  "gradientUnits",
  "gradientTransform",
]);

/** The linear and radial gradients an SVG defines, by id, with their stops. */
function gradients(svg: string, file: string): Map<string, Gradient> {
  const found = new Map<string, Gradient>();
  for (const match of svg.matchAll(/<(linear|radial)Gradient\b([^>]*)>([\s\S]*?)<\/\1Gradient>/g)) {
    const own = attributes(match[2] ?? "");
    const id = own.get("id");
    if (!id) throw new Error(`${file}: gradient without id`);
    const kept: Record<string, string> = {};
    for (const [name, value] of own) {
      if (name === "id") continue;
      if (!gradientAttributes.has(name))
        throw new Error(`${file}: unsupported gradient attribute ${name}`);
      kept[name] = value;
    }
    const stops = [...(match[3] ?? "").matchAll(/<stop\b[^>]*>/g)].map(([tag]) => {
      const a = attributes(tag);
      const color = a.get("stop-color");
      if (!color) throw new Error(`${file}: stop without a colour`);
      const opacity = a.get("stop-opacity");
      const stop: Gradient["stops"][number] = { offset: a.get("offset") ?? "0", color };
      if (opacity !== undefined) stop.opacity = Number(opacity);
      return stop;
    });
    found.set(id, { type: match[1] === "radial" ? "radial" : "linear", attributes: kept, stops });
  }
  return found;
}

/**
 * Reads one LobeHub SVG, refusing anything but plain paths and gradients so the art stays
 * renderer-neutral.
 */
function art(
  svgPath: string,
  adjust: { adapt?: string[]; drop?: string[] } = {},
): { viewBox: string; paths: Path[] } {
  const file = basename(svgPath);
  const svg = readFileSync(svgPath, "utf8");
  const allowed = new Set([
    "svg",
    "title",
    "path",
    "defs",
    "linearGradient",
    "radialGradient",
    "stop",
  ]);
  const elements = [...svg.matchAll(/<([a-zA-Z]+)\b/g)].map((m) => m[1]);
  const unexpected = elements.filter((name) => !allowed.has(name ?? ""));
  if (unexpected.length > 0) throw new Error(`${file}: unsupported elements ${unexpected.join()}`);
  const root = attributes(/<svg\b[^>]*>/.exec(svg)?.[0] ?? "");
  const viewBox = root.get("viewBox");
  if (viewBox === undefined) throw new Error(`${file}: no viewBox`);
  const inherited = rule(root.get("fill-rule"), file);
  const defined = gradients(svg, file);
  const paths = [...svg.matchAll(/<path\b[^>]*>/g)].flatMap(([tag]): Path[] => {
    const a = attributes(tag);
    for (const name of a.keys()) {
      if (!["d", "fill", "fill-rule", "clip-rule", "opacity"].includes(name))
        throw new Error(`${file}: unsupported path attribute ${name}`);
    }
    const d = a.get("d");
    if (!d) throw new Error(`${file}: path without d`);
    const fill = a.get("fill");
    if (fill && adjust.drop?.includes(fill)) return [];
    const fillRule = rule(a.get("fill-rule"), file) ?? inherited;
    const clipRule = rule(a.get("clip-rule"), file);
    const opacity = a.get("opacity");
    const path: Path = { d };
    const reference = fill && /^url\(#(.+)\)$/.exec(fill)?.[1];
    if (reference) {
      const gradient = defined.get(reference);
      if (!gradient) throw new Error(`${file}: unknown gradient ${reference}`);
      path.gradient = gradient;
    } else if (fill && fill !== "currentColor" && !adjust.adapt?.includes(fill)) path.fill = fill;
    if (fillRule === "evenodd") path.fillRule = fillRule;
    if (clipRule === "evenodd") path.clipRule = clipRule;
    if (opacity !== undefined) path.opacity = Number(opacity);
    return [path];
  });
  return { viewBox, paths };
}

const header = (source: string) =>
  `// Generated by scripts/provider-icons.ts from @lobehub/icons-static-svg ${version}\n` +
  `// (${source}, MIT, Copyright (c) 2023 LobeHub; see NOTICE). Do not edit.\n`;

const officialHeader = (source: string) =>
  `// Generated by scripts/provider-icons.ts from ${source}.\n` +
  `// The mark is its owner's trademark; see NOTICE. Do not edit.\n`;

/** Leave a half-unit margin for catalog paths that extend just beyond the nominal box. */
function paddedViewBox(viewBox: string): string {
  const [x = 0, y = 0, width = 24, height = 24] = viewBox.split(" ").map(Number);
  const pad = Math.max(width, height) / 48;
  return `${x - pad} ${y - pad} ${width + pad * 2} ${height + pad * 2}`;
}

const write = (key: string, head: string, brandArt: object) =>
  writeFileSync(
    join(out, `${key}.gen.ts`),
    `${head}import type { BrandArt } from "../brand-art-types.ts";\n\n` +
      `export const art: BrandArt = ${JSON.stringify(brandArt)};\n`,
  );

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const keys = [...Object.keys(brands), ...Object.keys(official)].toSorted();
for (const key of Object.keys(brands)) {
  if (key in official) throw new Error(`${key} is both a LobeHub and an official mark`);
  if (!readdirSync(icons).includes(`${key}.svg`)) throw new Error(`LobeHub has no ${key}.svg`);
  const mono = art(join(icons, `${key}.svg`));
  const brand = brands[key];
  const color = brand?.color ? art(join(icons, `${key}-color.svg`), brand) : undefined;
  const source = color ? `icons/${key}.svg, icons/${key}-color.svg` : `icons/${key}.svg`;
  write(key, header(source), {
    viewBox: paddedViewBox(mono.viewBox),
    mono: mono.paths,
    ...(color ? { color: color.paths } : {}),
  });
}
const officialSvg = (file: string) =>
  flatten(readFileSync(join(officialMarks, file), "utf8"), file);
for (const [key, mark] of Object.entries(official)) {
  const mono = officialSvg(mark.mono.file).paths.flatMap((path) => {
    if (mark.mono.knockout?.includes(path.fill)) return [];
    if (!mark.mono.ink.includes(path.fill))
      throw new Error(`${mark.mono.file}: fill ${path.fill} would not follow the theme`);
    const flat: Path = { d: path.d };
    if (path.fillRule) flat.fillRule = path.fillRule;
    return [flat];
  });
  const color = mark.color ? officialSvg(mark.color).paths : undefined;
  write(key, officialHeader(mark.source), {
    viewBox: paddedViewBox(mark.viewBox),
    mono,
    ...(color
      ? {
          color: color.map((path) => {
            const painted: Path = { d: path.d };
            if (path.fill !== "currentColor") painted.fill = path.fill;
            if (path.fillRule) painted.fillRule = path.fillRule;
            return painted;
          }),
        }
      : {}),
  });
}
writeFileSync(
  join(out, "index.gen.ts"),
  `// Generated by scripts/provider-icons.ts from @lobehub/icons-static-svg ${version} (icons/*.svg)\n` +
    `// and scripts/brand-marks/ (each owner's brand kit); see NOTICE. Do not edit.\n` +
    `import type { BrandArt } from "../brand-art-types.ts";\n\n` +
    `/** Every brand ace has a mark for. */\n` +
    `export type Brand = ${keys.map((key) => JSON.stringify(key)).join(" | ")};\n\n` +
    `/** Loads one brand's mark; each is its own chunk. */\n` +
    `export const brandArt: Record<Brand, () => Promise<BrandArt>> = {\n` +
    keys.map((key) => `  ${key}: () => import("./${key}.gen.ts").then((m) => m.art),\n`).join("") +
    `};\n`,
);
process.stdout.write(`Wrote ${keys.length} brand marks to ${out}\n`);
