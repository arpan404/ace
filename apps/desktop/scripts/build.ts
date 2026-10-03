#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { z } from "zod";
import { bundleDaemon } from "@ace/release";
import { desktop, dist, electronBundles, releasePublicKey, repo } from "./common.ts";

/**
 * Builds everything the packaged app ships, into `apps/desktop/dist`:
 * - `app/`: main, preload, the web renderer and the app's package.json (becomes app.asar);
 * - `daemon/`: the daemon bundle from `@ace/release`, its worker bundles, staged runtime
 *   packages (koffi, playwright-core, the Claude SDK), `descriptor.node` and node-pty;
 * - `helpers/`: the screen helper for this platform;
 * - `bin/rg`: ripgrep for workspace search.
 * Native code is built for the host platform; build each OS on that OS.
 */
const log = (message: string) => console.log(`[build] ${message}`);
const run = (command: string, args: string[], cwd = repo) =>
  execFileSync(command, args, { cwd, stdio: "inherit" });

await rm(dist, { recursive: true, force: true });
const app = join(dist, "app");
await mkdir(app, { recursive: true });

log("main and preload");
await Promise.all(electronBundles(app, process.env).map((options) => build(options)));

log("renderer (apps/web)");
run(
  "bun",
  ["x", "vite", "build", "--outDir", join(app, "renderer"), "--emptyOutDir"],
  join(repo, "apps/web"),
);

const manifest = z
  .object({ version: z.string(), description: z.string(), license: z.string() })
  .parse(JSON.parse(await readFile(join(desktop, "package.json"), "utf8")));
await writeFile(
  join(app, "package.json"),
  JSON.stringify(
    {
      name: "ace",
      productName: "ace",
      version: process.env.ACE_VERSION ?? manifest.version,
      description: manifest.description,
      license: manifest.license,
      author: "ace",
      main: "main.cjs",
    },
    null,
    2,
  ),
);

log("daemon bundle");
const daemon = join(dist, "daemon");
await mkdir(daemon, { recursive: true });
await bundleDaemon(repo, daemon, releasePublicKey(process.env));
await stageNodePty(daemon);
await copyFile(join(repo, "LICENSE"), join(daemon, "ACE-LICENSE"));

log("ripgrep");
await stageRipgrep(join(dist, "bin"));

log("screen helper");
await stageScreenHelper(join(dist, "helpers"));
log(`done: ${dist}`);

/**
 * node-pty is external to the bundle. It is a Node-API addon, so one binary serves Node and
 * Electron's Node alike; a binary rebuilt by `desktop:rebuild-native` (build/Release) wins
 * over the npm prebuild, and is the only option on Linux, which has no prebuilds.
 */
async function stageNodePty(root: string): Promise<void> {
  const require = createRequire(join(repo, "packages/terminal/package.json"));
  const source = dirname(require.resolve("node-pty/package.json"));
  const target = join(root, "node_modules/node-pty");
  await mkdir(target, { recursive: true });
  for (const name of ["lib", "package.json", "LICENSE"])
    await cp(join(source, name), join(target, name), { recursive: true });
  const rebuilt = join(source, "build/Release");
  const prebuild = join(source, "prebuilds", `${process.platform}-${process.arch}`);
  const from = existsSync(join(rebuilt, "pty.node")) ? rebuilt : prebuild;
  const to =
    from === rebuilt
      ? join(target, "build/Release")
      : join(target, "prebuilds", `${process.platform}-${process.arch}`);
  if (!existsSync(join(from, "pty.node")))
    throw new Error(
      "No node-pty binary for this platform; run `bun run desktop:rebuild-native` first",
    );
  await mkdir(to, { recursive: true });
  await copyFile(join(from, "pty.node"), join(to, "pty.node"));
  if (existsSync(join(from, "spawn-helper"))) {
    await copyFile(join(from, "spawn-helper"), join(to, "spawn-helper"));
    await chmod(join(to, "spawn-helper"), 0o755);
  }
}

async function stageRipgrep(bin: string): Promise<void> {
  const { rgPath } = await import("@vscode/ripgrep");
  await mkdir(bin, { recursive: true });
  const name = process.platform === "win32" ? "rg.exe" : "rg";
  await copyFile(rgPath, join(bin, name));
  await chmod(join(bin, name), 0o755);
  const license = join(dirname(dirname(rgPath)), "LICENSE");
  if (existsSync(license)) await copyFile(license, join(bin, "ripgrep-LICENSE"));
}

/**
 * macOS: the Swift helper as a signed `.app` with a stable bundle id, plus the manifest the
 * daemon verifies before installing it. Windows and Linux: the Rust helpers via cargo.
 * A missing toolchain skips the helper with a warning; screen use is then unavailable.
 */
async function stageScreenHelper(helpers: string): Promise<void> {
  await mkdir(helpers, { recursive: true });
  try {
    if (process.platform === "darwin") {
      run("sh", [join(repo, "native/screen-helper/build.sh")]);
      const built = join(repo, "native/screen-helper/build");
      await cp(join(built, "AceScreenHelper.app"), join(helpers, "AceScreenHelper.app"), {
        recursive: true,
        verbatimSymlinks: true,
      });
      await copyFile(join(built, "manifest.json"), join(helpers, "manifest.json"));
    } else if (process.platform === "win32") {
      const triple =
        process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
      const crate = join(repo, "native/screen-helper-windows");
      run("cargo", ["build", "--locked", "--release", "--target", triple], crate);
      await copyFile(
        join(crate, "target", triple, "release/ace-screen-helper-windows.exe"),
        join(helpers, "ace-screen-helper-windows.exe"),
      );
    } else if (process.platform === "linux") {
      run("sh", [join(repo, "native/screen-helper-linux/build.sh")]);
      const triple =
        process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
      await copyFile(
        join(repo, "native/screen-helper-linux/build", `ace-screen-helper-linux-${triple}`),
        join(helpers, "ace-screen-helper-linux"),
      );
      await chmod(join(helpers, "ace-screen-helper-linux"), 0o755);
    }
  } catch (error) {
    if (process.env.ACE_REQUIRE_SCREEN_HELPER === "1") throw error;
    console.warn(
      `[build] screen helper skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
