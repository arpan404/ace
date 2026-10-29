import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const root = join(pkg, "..", "..");
const markit = join(root, "packages", "markit");
const web = join(markit, "web");
const out = join(root, "apps", "web", "public", "markit");

const wasm = join(web, "pkg", "markit_wasm_bg.wasm");
if (!existsSync(wasm)) {
  const home = process.env.HOME ?? "";
  const candidates = [
    join(home, ".rustup", "toolchains", "1.91.1-aarch64-apple-darwin", "bin"),
    join(home, ".rustup", "toolchains", "stable-aarch64-apple-darwin", "bin"),
  ];
  const path = process.env.PATH
    ? `${candidates.join(":")}:${process.env.PATH}`
    : candidates.join(":");
  execFileSync("bash", [join(markit, "scripts", "build-web.sh")], {
    cwd: markit,
    stdio: "inherit",
    env: { ...process.env, PATH: path, RUSTUP_TOOLCHAIN: "1.91.1" },
  });
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of [
  "worker.js",
  "index.js",
  "react.js",
  "highlight.js",
  "code-lines.js",
  "style.css",
]) {
  cpSync(join(web, file), join(out, file));
}
cpSync(join(web, "pkg"), join(out, "pkg"), { recursive: true });
cpSync(join(web, "licenses"), join(out, "licenses"), { recursive: true });

process.stdout.write(`markit web assets synced to apps/web/public/markit\n`);
