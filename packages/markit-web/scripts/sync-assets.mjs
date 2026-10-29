import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Builds markit's Wasm worker from the packages/markit submodule and copies the web assets to
 * apps/web/public/markit. The build reruns whenever the submodule commit, its local edits or
 * MARKIT_FEATURES change, so a submodule bump never ships a stale Wasm file.
 *
 * Needs Rust with the wasm32-unknown-unknown target and wasm-bindgen-cli matching the
 * wasm-bindgen version in packages/markit/Cargo.lock.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const markit = join(root, "packages", "markit");
const web = join(markit, "web");
const out = join(root, "apps", "web", "public", "markit");
const wasm = join(web, "pkg", "markit_wasm_bg.wasm");
const stampFile = join(web, "pkg", ".ace-build");

if (!existsSync(join(markit, "Cargo.toml"))) {
  process.stderr.write(
    "packages/markit is empty: run `git submodule update --init --recursive` first.\n",
  );
  process.exit(1);
}

const git = (...args) => execFileSync("git", ["-C", markit, ...args], { encoding: "utf8" });
const stamp = JSON.stringify({
  head: git("rev-parse", "HEAD").trim(),
  edits: git("status", "--porcelain", "--untracked-files=no"),
  features: process.env.MARKIT_FEATURES ?? "",
});
const built = existsSync(stampFile) ? readFileSync(stampFile, "utf8") : undefined;

if (!existsSync(wasm) || built !== stamp) {
  try {
    execFileSync("bash", [join(markit, "scripts", "build-web.sh")], {
      cwd: markit,
      stdio: "inherit",
    });
  } catch (error) {
    process.stderr.write(
      "\nBuilding markit's Wasm failed. It needs Rust with the wasm32-unknown-unknown target " +
        "(`rustup target add wasm32-unknown-unknown`) and wasm-bindgen-cli at the version in " +
        "packages/markit/Cargo.lock (`cargo install wasm-bindgen-cli --version <v> --locked`).\n",
    );
    throw error;
  }
  writeFileSync(stampFile, stamp);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// Only the worker loads from /markit (with the render core it shares with the in-process engine,
// in markit versions that have one); the renderer, its styles and helpers are bundled by Vite.
for (const file of ["worker.js", "render-core.js"]) {
  if (existsSync(join(web, file))) cpSync(join(web, file), join(out, file));
}
cpSync(join(web, "pkg"), join(out, "pkg"), {
  recursive: true,
  filter: (source) => !source.endsWith(".ace-build"),
});
cpSync(join(web, "licenses"), join(out, "licenses"), { recursive: true });

process.stdout.write("markit web assets synced to apps/web/public/markit\n");
