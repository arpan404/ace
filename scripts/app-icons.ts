import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { flatten } from "./brand-marks/flatten.ts";
import { paddedViewBox } from "./brand-marks/view-box.ts";

/*
 * Turns the marks of the apps in Spade's connector catalogue (`spade/config/connectors.json`)
 * into plain path data in `packages/ui-core/src/app-art/`, one module per app so the app loads a
 * mark only when it is on screen, and writes `LICENCES.md` beside them: each mark's source,
 * licence and its maker's brand guidelines.
 *
 * Marks come from Simple Icons (`simple-icons`, CC0-1.0, read from the pinned devDependency) or,
 * where Simple Icons has none, from the maker's own site, kept byte-for-byte in
 * `scripts/brand-marks/apps/` and read by `brand-marks/flatten.ts`. An app with neither gets no
 * mark and the app draws a neutral monogram; nothing is drawn to look like a logo.
 *
 *   node scripts/app-icons.ts
 *
 * Every catalogue entry must be listed below, so a new app can't ship without a decision.
 */

type Mark =
  /** A Simple Icons slug. */
  | { simple: string }
  /** A file in `scripts/brand-marks/apps/`, from the maker's own site. */
  | { maker: string; source: string; guidelines?: string }
  /** No mark we may ship yet: a monogram. Says where the owner can get one. */
  | { none: string };

const kit = (domain: string) => `the maker's brand assets at ${domain}`;

const marks: Record<string, Mark> = {
  airtable: { simple: "airtable" },
  amplitude: { none: kit("amplitude.com/brand") },
  apollo: { none: kit("apollo.io (press kit)") },
  asana: { simple: "asana" },
  atlassian: { simple: "atlassian" },
  attio: { none: kit("attio.com (press kit)") },
  axiom: { none: kit("axiom.co (brand)") },
  basecamp: { simple: "basecamp" },
  box: { simple: "box" },
  buildkite: { simple: "buildkite" },
  calcom: { simple: "caldotcom" },
  calendly: { simple: "calendly" },
  canva: { none: kit("canva.com/newsroom (media assets)") },
  clerk: { simple: "clerk" },
  clickup: { simple: "clickup" },
  close: { none: kit("close.com (brand)") },
  cloudflare: { simple: "cloudflare" },
  cloudinary: { simple: "cloudinary" },
  contentful: { simple: "contentful" },
  datadog: { simple: "datadog" },
  dropbox: { simple: "dropbox" },
  figma: { simple: "figma" },
  fireflies: { none: kit("fireflies.ai (press)") },
  framer: { simple: "framer" },
  front: { none: kit("front.com/brand") },
  gamma: { none: kit("gamma.app (press)") },
  github: { simple: "github" },
  gitlab: { simple: "gitlab" },
  gmail: { simple: "gmail" },
  "google-calendar": { simple: "googlecalendar" },
  "google-chat": { simple: "googlechat" },
  "google-docs": { simple: "googledocs" },
  "google-drive": { simple: "googledrive" },
  "google-sheets": { simple: "googlesheets" },
  "google-slides": { simple: "googleslides" },
  grafana: { simple: "grafana" },
  granola: { none: kit("granola.ai (press)") },
  guru: { none: kit("getguru.com (brand)") },
  helpscout: { simple: "helpscout" },
  hex: {
    maker: "hex.svg",
    source: "Hex's site icon, https://hex.tech/favicon.svg",
  },
  hubspot: { simple: "hubspot" },
  huggingface: { simple: "huggingface" },
  intercom: { simple: "intercom" },
  jam: {
    maker: "jam.svg",
    source:
      "Jam's site icon as jam.dev serves it, https://framerusercontent.com/images/3zAY5a6TukbdTWkNAkTDO1Yqpc.svg",
  },
  jotform: { none: kit("jotform.com/press") },
  klaviyo: { none: kit("klaviyo.com/brand") },
  launchdarkly: { none: kit("launchdarkly.com/brand") },
  linear: { simple: "linear" },
  lucid: { simple: "lucid" },
  make: { simple: "make" },
  mercury: {
    maker: "mercury.svg",
    source: "Mercury's site icon, https://mercury.com/icon.svg",
  },
  miro: { simple: "miro" },
  mixpanel: { simple: "mixpanel" },
  monday: { none: kit("monday.com/brand") },
  mongodb: { simple: "mongodb" },
  neon: { simple: "neon" },
  netlify: { simple: "netlify" },
  notion: { simple: "notion" },
  pagerduty: { simple: "pagerduty" },
  paypal: { simple: "paypal" },
  pipedrive: { none: kit("pipedrive.com/en/brand") },
  planetscale: { simple: "planetscale" },
  posthog: { simple: "posthog" },
  postman: { simple: "postman" },
  prisma: { simple: "prisma" },
  railway: { simple: "railway" },
  ramp: { none: kit("ramp.com/brand") },
  readwise: { none: kit("readwise.io (press)") },
  render: { simple: "render" },
  resend: { simple: "resend" },
  rootly: {
    maker: "rootly.svg",
    source: "Rootly's site icon, https://rootly.com/brand/favicon.svg",
  },
  sanity: { simple: "sanity" },
  sentry: { simple: "sentry" },
  slack: {
    maker: "slack.svg",
    source:
      "Slack's own mark as slack.com serves it, https://a.slack-edge.com/1f40066/marketing/img/nav/logo.svg",
    guidelines: "https://slack.com/media-kit",
  },
  smartsheet: {
    maker: "smartsheet.svg",
    source:
      "Smartsheet's pinned-tab icon, https://www.smartsheet.com/sites/default/files/favicons/safari-pinned-tab.svg",
  },
  square: { simple: "square" },
  stripe: { simple: "stripe" },
  supabase: { simple: "supabase" },
  tally: {
    maker: "tally.svg",
    source: "Tally's site icon, https://tally.so/favicon.svg",
  },
  todoist: { simple: "todoist" },
  vercel: { simple: "vercel" },
  webflow: { simple: "webflow" },
  wix: { simple: "wix" },
  zapier: { simple: "zapier" },
  zoom: { simple: "zoom" },
};

interface SimpleIcon {
  title: string;
  slug: string;
  hex: string;
  source: string;
  guidelines?: string;
  license?: { type: string; url?: string };
}

interface Path {
  d: string;
  fill?: string;
  fillRule?: "evenodd";
}

const root = join(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const simpleRoot = join(require.resolve("simple-icons"), "..");
const simpleVersion = (
  JSON.parse(readFileSync(join(simpleRoot, "package.json"), "utf8")) as { version: string }
).version;
const simpleData = JSON.parse(
  readFileSync(join(simpleRoot, "data", "simple-icons.json"), "utf8"),
) as SimpleIcon[];
const catalogue = JSON.parse(
  readFileSync(join(root, "spade", "config", "connectors.json"), "utf8"),
) as { connectors: { id: string; name: string }[] };
const out = join(root, "packages", "ui-core", "src", "app-art");

const named = new Map(catalogue.connectors.map((entry) => [entry.id, entry.name]));
const missing = [...named.keys()].filter((id) => !(id in marks));
const extra = Object.keys(marks).filter((id) => !named.has(id));
if (missing.length || extra.length)
  throw new Error(`marks and catalogue differ: missing ${missing.join()}; extra ${extra.join()}`);

/** Relative luminance of a `#rrggbb` colour (WCAG). */
function luminance(hex: string): number {
  const channel = (at: number) => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * A brand whose colour is black or nearly (navy, charcoal) draws in the text colour, so it shows
 * on dark surfaces too.
 */
const black = (fill: string) => /^#?0{3,6}$|^black$/i.test(fill) || luminance(fullHex(fill)) < 0.06;
function fullHex(fill: string): string {
  const hex = fill.replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) return `#${[...hex].map((c) => c + c).join("")}`;
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex}` : "#888888";
}

type Row = {
  id: string;
  name: string;
  mark: string;
  source: string;
  licence: string;
  guidelines: string;
};
const rows: Row[] = [];
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const written: string[] = [];

for (const [id, mark] of Object.entries(marks).toSorted(([a], [b]) => a.localeCompare(b))) {
  const name = named.get(id) ?? id;
  if ("none" in mark) {
    rows.push({
      id,
      name,
      mark: "Monogram (no mark bundled yet)",
      source: `To add: ${mark.none}`,
      licence: "",
      guidelines: "",
    });
    continue;
  }
  let viewBox: string;
  let color: Path[] | undefined;
  let mono: Path[];
  let header: string;
  if ("simple" in mark) {
    const icon = simpleData.find((each) => each.slug === mark.simple);
    if (!icon) throw new Error(`Simple Icons ${simpleVersion} has no ${mark.simple}`);
    const svg = readFileSync(join(simpleRoot, "icons", `${mark.simple}.svg`), "utf8");
    const d = /<path d="([^"]+)"/.exec(svg)?.[1];
    if (!d) throw new Error(`${mark.simple}.svg has no path`);
    viewBox = "0 0 24 24";
    mono = [{ d }];
    color = black(`#${icon.hex}`) ? undefined : [{ d, fill: `#${icon.hex}` }];
    const licence = icon.license?.type ?? "CC0-1.0";
    header = `// Generated by scripts/app-icons.ts from simple-icons ${simpleVersion} (icons/${mark.simple}.svg, ${licence}).\n`;
    rows.push({
      id,
      name,
      mark: `Simple Icons \`${mark.simple}\` (${simpleVersion})`,
      source: icon.source,
      licence:
        licence === "CC0-1.0"
          ? "CC0-1.0 (Simple Icons)"
          : `${licence} (as Simple Icons records it)`,
      guidelines: icon.guidelines ?? "",
    });
  } else {
    const file = join(import.meta.dirname, "brand-marks", "apps", mark.maker);
    const flat = flatten(readFileSync(file, "utf8"), mark.maker);
    viewBox = flat.viewBox;
    const paths = flat.paths.map((path): Path => {
      const painted: Path = { d: path.d };
      // The maker's black follows the text colour, so its outline shows on dark surfaces too.
      if (path.fill !== "currentColor" && !black(path.fill)) painted.fill = path.fill;
      if (path.fillRule) painted.fillRule = path.fillRule;
      return painted;
    });
    mono = paths.map(({ d, fillRule }) => (fillRule ? { d, fillRule } : { d }));
    color = paths.every((path) => !path.fill) ? undefined : paths;
    header = `// Generated by scripts/app-icons.ts from ${mark.source}.\n`;
    rows.push({
      id,
      name,
      mark: `Maker's own, \`scripts/brand-marks/apps/${mark.maker}\``,
      source: mark.source,
      licence: "The maker's trademark, shown only to name its app",
      guidelines: mark.guidelines ?? "",
    });
  }
  writeFileSync(
    join(out, `${id}.gen.ts`),
    `${header}// The mark is its owner's trademark; see LICENCES.md beside this file. Do not edit.\n` +
      `import type { BrandArt } from "../brand-art-types.ts";\n\n` +
      `export const art: BrandArt = ${JSON.stringify({ viewBox: paddedViewBox(viewBox), mono, ...(color ? { color } : {}) })};\n`,
  );
  written.push(id);
}

writeFileSync(
  join(out, "index.gen.ts"),
  `// Generated by scripts/app-icons.ts from spade/config/connectors.json; see LICENCES.md. Do not edit.\n` +
    `import type { BrandArt } from "../brand-art-types.ts";\n\n` +
    `/** Loads a catalogue app's mark by its catalogue id; each is its own chunk. */\n` +
    `export const appArt: Readonly<Record<string, () => Promise<BrandArt>>> = {\n` +
    written
      .map((id) => `  ${JSON.stringify(id)}: () => import("./${id}.gen.ts").then((m) => m.art),\n`)
      .join("") +
    `};\n`,
);

const cell = (text: string) => text.replaceAll("|", "\\|");
writeFileSync(
  join(out, "LICENCES.md"),
  `# App marks\n\n` +
    `Generated by \`scripts/app-icons.ts\`; do not edit. One row per app in Spade's connector\n` +
    `catalogue (\`spade/config/connectors.json\`).\n\n` +
    `Each mark is its owner's trademark, shown only to name the owner's app where a person\n` +
    `connects it; none is licensed under ace's licence. Simple Icons (https://simpleicons.org)\n` +
    `publishes its path data under CC0-1.0 unless the row says otherwise; its own disclaimer asks\n` +
    `users to follow each brand's guidelines, linked here where Simple Icons records them. Apps with\n` +
    `no mark yet draw a neutral monogram of their name's first letter.\n\n` +
    `| App | Id | Mark | Source | Licence | Brand guidelines |\n` +
    `| --- | --- | --- | --- | --- | --- |\n` +
    rows
      .map(
        (row) =>
          `| ${cell(row.name)} | \`${row.id}\` | ${cell(row.mark)} | ${cell(row.source)} | ${cell(row.licence)} | ${cell(row.guidelines)} |`,
      )
      .join("\n") +
    `\n`,
);
process.stdout.write(
  `Wrote ${written.length} app marks (${rows.length - written.length} monograms) to ${out}\n`,
);
