import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/*
 * Turns the brand marks ace shows for providers, ACP agents and model families into plain path
 * data in `packages/ui-core/src/brand-art/`. The marks come from LobeHub Icons
 * (`@lobehub/icons-static-svg`, MIT, see NOTICE); nothing else is read. Each brand becomes its
 * own module so the web app loads a mark only when one is on screen.
 *
 *   node scripts/provider-icons.ts
 *
 * To add a brand: add it to `brands` below, run this, then map it in
 * `packages/ui-core/src/provider-icons.ts`.
 */

/**
 * Brand key → how its colour variant is made. `color` uses LobeHub's full-colour SVG; marks
 * without one (OpenAI, Cursor, OpenCode…) are black-and-white brands and draw in the text colour.
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
  codex: { color: true, drop: ["#fff"] },
  cursor: { color: false },
  deepseek: { color: true },
  devin: { color: true },
  gemini: { color: true },
  geminicli: { color: true },
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
  openai: { color: false },
  opencode: { color: false },
  pi: { color: false },
  qoder: { color: true },
  qwen: { color: true },
  snowflake: { color: true },
  zai: { color: false },
};

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
  new Map([...tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map((m) => [m[1] ?? "", m[2] ?? ""]));

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
  file: string,
  adjust: { adapt?: string[]; drop?: string[] } = {},
): { viewBox: string; paths: Path[] } {
  const svg = readFileSync(join(icons, file), "utf8");
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

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const keys = Object.keys(brands).toSorted();
for (const key of keys) {
  if (!readdirSync(icons).includes(`${key}.svg`)) throw new Error(`LobeHub has no ${key}.svg`);
  const mono = art(`${key}.svg`);
  const brand = brands[key];
  const color = brand?.color ? art(`${key}-color.svg`, brand) : undefined;
  const source = color ? `icons/${key}.svg, icons/${key}-color.svg` : `icons/${key}.svg`;
  writeFileSync(
    join(out, `${key}.gen.ts`),
    `${header(source)}import type { BrandArt } from "../brand-art-types.ts";\n\n` +
      `export const art: BrandArt = ${JSON.stringify({
        viewBox: mono.viewBox,
        mono: mono.paths,
        ...(color ? { color: color.paths } : {}),
      })};\n`,
  );
}
writeFileSync(
  join(out, "index.gen.ts"),
  `${header("icons/*.svg")}import type { BrandArt } from "../brand-art-types.ts";\n\n` +
    `/** Every brand ace has a mark for. */\n` +
    `export type Brand = ${keys.map((key) => JSON.stringify(key)).join(" | ")};\n\n` +
    `/** Loads one brand's mark; each is its own chunk. */\n` +
    `export const brandArt: Record<Brand, () => Promise<BrandArt>> = {\n` +
    keys.map((key) => `  ${key}: () => import("./${key}.gen.ts").then((m) => m.art),\n`).join("") +
    `};\n`,
);
process.stdout.write(`Wrote ${keys.length} brand marks to ${out}\n`);
