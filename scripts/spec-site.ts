/*
 * The Spade Agent Format's site (ADR 0201 §4): `spade/spec/` as static files for
 * `spec.acehq.dev`, generated and never edited by hand. Each Markdown part becomes a page, the
 * conformance suite is served as it is, and the JSON Schemas sit at their stable addresses,
 * `/<version>/<name>.schema.json`. `buildSite` is pure; running this file reads `spade/spec/` and
 * writes the site to `spade/spec/dist/` (git-ignored). The founder deploys it.
 *
 *   bun run spec:site
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { Marked } from "marked";

/** The spec's files by path under `spade/spec/`, as text. */
export type SpecFiles = ReadonlyMap<string, string>;

const marked = new Marked({ gfm: true });

/** The format version the spec's README names in its title. */
export function specVersion(files: SpecFiles): string {
  const title = files.get("README.md")?.match(/^# Spade Agent Format (\d+\.\d+)$/m);
  if (!title?.[1]) throw new Error("spade/spec/README.md names no format version in its title");
  return title[1];
}

/** A page's path on the site: `README.md` is its folder's index. */
export function pagePath(markdown: string): string {
  return markdown.replace(/(^|\/)README\.md$/, "$1index.html").replace(/\.md$/, ".html");
}

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** A relative link to a Markdown file of the spec, pointed at its page. */
function relink(html: string): string {
  return html.replace(/href="(?![a-z]+:|#|\/)([^"#]*\.md)(#[^"]*)?"/g, (_all, path, hash) => {
    return `href="${pagePath(path)}${hash ?? ""}"`;
  });
}

const style = `body{font:16px/1.6 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#1c1c1c}
a{color:#2f5fd0}code{font:0.9em ui-monospace,monospace;background:#f2f2f2;padding:0 .2em;border-radius:3px}
table{border-collapse:collapse;display:block;overflow-x:auto}th,td{border:1px solid #ddd;padding:.3rem .6rem;text-align:left;vertical-align:top}
nav{font-size:.9rem;margin-bottom:2rem}nav a{margin-right:.8rem}
@media (prefers-color-scheme:dark){body{background:#141414;color:#e6e6e6}a{color:#8fb0ff}code{background:#262626}th,td{border-color:#333}}`;

function page(path: string, markdown: string, nav: string[]): string {
  const body = relink(marked.parse(markdown.replace(/<!--[\s\S]*?-->\n?/g, "")) as string);
  const title = markdown.match(/^# (.+)$/m)?.[1] ?? "Spade Agent Format";
  const up = "../".repeat(path.split("/").length - 1);
  const links = nav.map((to) => {
    const name = to === "index.html" ? "Spade Agent Format" : to.replace(/\.html$/, "");
    return `<a href="${up}${to}">${escape(name)}</a>`;
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>${style}</style>
</head>
<body>
<nav>${links.join("")}</nav>
<main>
${body}</main>
</body>
</html>
`;
}

/** Cloudflare Pages' headers: schemas and cases fetched by editors and other runtimes. */
function headers(version: string): string {
  return `/${version}/*
  Access-Control-Allow-Origin: *
/${version}/*.schema.json
  Content-Type: application/schema+json; charset=utf-8
/schemas/*
  Access-Control-Allow-Origin: *
/conformance/*
  Access-Control-Allow-Origin: *
`;
}

/** Every file of the site, by path. */
export function buildSite(files: SpecFiles): Map<string, string> {
  const version = specVersion(files);
  const out = new Map<string, string>();
  const markdown = [...files.keys()].filter((path) => path.endsWith(".md")).toSorted();
  const nav = markdown
    .filter((path) => !path.includes("/") && path !== "LICENSE.md")
    .map(pagePath)
    .toSorted((a, b) => (a === "index.html" ? -1 : b === "index.html" ? 1 : a.localeCompare(b)));
  for (const path of markdown) out.set(pagePath(path), page(path, files.get(path) ?? "", nav));
  for (const [path, text] of files) {
    if (!path.endsWith(".json")) continue;
    out.set(path, text);
    // The schemas' stable addresses (ADR 0201 §4).
    if (path.startsWith("schemas/")) out.set(`${version}/${path.slice("schemas/".length)}`, text);
  }
  out.set("_headers", headers(version));
  return out;
}

/** The spec's Markdown and JSON files under `root`, by path; the built site is left out. */
export function readSpec(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (name === "dist") continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(md|json)$/.test(name))
        files.set(relative(root, full), readFileSync(full, "utf8"));
    }
  };
  walk(root);
  return files;
}

if (import.meta.main) {
  const root = new URL("../spade/spec/", import.meta.url).pathname;
  const dist = join(root, "dist");
  const site = buildSite(readSpec(root));
  rmSync(dist, { recursive: true, force: true });
  for (const [path, text] of site) {
    const to = join(dist, path);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, text);
  }
  console.log(`Wrote ${site.size} files to ${relative(process.cwd(), dist) || dist}`);
}
