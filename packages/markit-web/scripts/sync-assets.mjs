import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { markitPackageDirectory } from "../src/assets.ts";

/*
 * Copies markit's web assets to apps/web/public/markit. markit is installed prebuilt from its
 * GitHub release (`@markit/web` in this package's dependencies, pinned with its integrity in
 * bun.lock), so this builds nothing and needs no Rust.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const web = markitPackageDirectory();
const out = join(root, "apps", "web", "public", "markit");
if (!existsSync(join(web, "pkg", "markit_wasm_bg.wasm"))) {
  process.stderr.write(`markit's Wasm is missing from ${web}: run \`bun install\`.\n`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// Only the worker loads from /markit (with the render core it shares with the in-process engine,
// in markit versions that have one); the renderer, its styles and helpers are bundled by Vite.
for (const file of ["worker.js", "render-core.js"]) {
  if (existsSync(join(web, file))) cpSync(join(web, file), join(out, file));
}
cpSync(join(web, "pkg"), join(out, "pkg"), { recursive: true });
// The license tree is hundreds of files; installed updaters refuse archives over
// their entry budget (`releaseArchiveLimits` in `@ace/service`), and nothing loads
// these files at runtime, so they ship as one consolidated notice.
const licenseRoot = join(web, "licenses");
if (!existsSync(licenseRoot)) {
  process.stderr.write(`markit licenses missing: expected a licenses tree in ${web}.\n`);
  process.exit(1);
}
const noticePaths = [];
const collectNotices = (directory) => {
  const entries = readdirSync(directory, { withFileTypes: true }).toSorted((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) collectNotices(full);
    else if (entry.isFile()) noticePaths.push(full);
  }
};
collectNotices(licenseRoot);
const notices = noticePaths
  .map((full) => {
    const heading = relative(licenseRoot, full);
    const text = readFileSync(full, "utf8").trimEnd();
    return `${"=".repeat(78)}\n${heading}\n${"=".repeat(78)}\n\n${text}\n`;
  })
  .join("\n");
writeFileSync(join(out, "licenses.txt"), notices);

process.stdout.write("markit web assets synced to apps/web/public/markit\n");
