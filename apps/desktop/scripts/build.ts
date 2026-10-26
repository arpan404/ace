#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { z } from "zod";
import { bundleDaemon, linuxScreenHelperName, stageLinuxScreenHelper } from "@ace/release";
import { stageNodeRuntime, stageWindowsNodeRuntime } from "@ace/release/node-runtime";
import { DesktopApp, desktopAppMarker } from "@ace/service/desktop-update";
import {
  desktop,
  dist,
  electronBundles,
  mainEntry,
  packagedAppVersion,
  releasePublicKey,
  repo,
  targetArch,
} from "./common.ts";
import { verifyNatives } from "./verify-natives.ts";

/**
 * Builds everything the packaged app ships, into `apps/desktop/dist`:
 * - `app/`: main, preload, the web renderer and the app's package.json (becomes app.asar);
 * - `daemon/`: the daemon bundle from `@ace/release`, its worker bundles, staged runtime
 *   packages (koffi, playwright-core, the Claude SDK), `descriptor.node`, node-pty and
 *   `desktop-app.json` (the app's version, so the bundled `ace update` defers to the app);
 * - `helpers/`: the screen helper for this platform;
 * - `bin/rg`: ripgrep for workspace search;
 * - `runtime/`: the pinned Node runtime the daemon runs on (macOS and Linux).
 * Native code is built for the host, so a build targets the host's OS and architecture
 * (`--arch` must match it; release CI builds each architecture on its own runner). Before it
 * finishes, every staged native binary is checked against the target architecture.
 */
const log = (message: string) => console.log(`[build] ${message}`);
const arch = targetArch(process.argv);
if (arch !== process.arch)
  throw new Error(
    `This machine builds ${process.arch} native code; build the ${arch} app on a ${arch} machine`,
  );
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
// ACE_VERSION may be "development" from a running daemon's environment: only semver ships.
const appVersion = packagedAppVersion(process.env, manifest.version);
await writeFile(
  join(app, "package.json"),
  JSON.stringify(
    {
      name: "ace",
      productName: "ace",
      version: appVersion,
      description: manifest.description,
      license: manifest.license,
      author: "ace",
      // The deb's Homepage field; electron-builder requires one for Linux packages.
      homepage: "https://github.com/arpan404/ace",
      // Linux window class / Wayland app_id and the installed entry's name. Reverse-DNS, as
      // portals require: GNOME refuses global shortcuts to an app id like `ace-desktop`.
      desktopName: "dev.ace.app.desktop",
      main: mainEntry,
    },
    null,
    2,
  ),
);

log("daemon bundle");
const daemon = join(dist, "daemon");
await mkdir(daemon, { recursive: true });
await bundleDaemon(repo, daemon, releasePublicKey(process.env));
await cp(join(app, "renderer"), join(daemon, "web"), { recursive: true });
await stageNodePty(daemon);
await copyFile(join(repo, "LICENSE"), join(daemon, "ACE-LICENSE"));
// The bundled CLI's `ace update` hands the update to the app instead (ADR 0091).
await writeFile(
  join(daemon, desktopAppMarker),
  JSON.stringify(DesktopApp.parse({ version: appVersion })) + "\n",
);

log("ripgrep");
await stageRipgrep(join(dist, "bin"));

log("screen helper");
await stageScreenHelper(join(dist, "helpers"));

const releaseTarget = `${process.platform}-${arch}`;
if (
  releaseTarget === "darwin-arm64" ||
  releaseTarget === "darwin-x64" ||
  releaseTarget === "linux-arm64" ||
  releaseTarget === "linux-x64"
) {
  log("node runtime");
  const runtime = join(dist, "runtime");
  const cacheDir = join(desktop, "node_modules/.cache/ace-node");
  await mkdir(runtime, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await stageNodeRuntime({
    target: releaseTarget,
    version: appVersion,
    cacheDir,
    destination: runtime,
  });
} else if (releaseTarget === "win32-x64" || releaseTarget === "win32-arm64") {
  log("node runtime");
  const runtime = join(dist, "runtime");
  const cacheDir = join(desktop, "node_modules/.cache/ace-node");
  await mkdir(runtime, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await stageWindowsNodeRuntime({ target: releaseTarget, cacheDir, destination: runtime });
}

log(`native code for ${process.platform}-${arch}`);
await verifyNatives(arch);
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
  if (process.platform === "win32") {
    // Windows ships the ConPTY closure; staging is owned by @ace/release/pty-assets.
    const { stagePtyFiles } = await import("@ace/release/pty-assets");
    await stagePtyFiles(source, target, `${process.platform}-${process.arch}`);
    return;
  }
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
      await stageLinuxScreenHelper(repo, join(helpers, linuxScreenHelperName));
    }
  } catch (error) {
    if (process.env.ACE_REQUIRE_SCREEN_HELPER === "1") throw error;
    console.warn(
      `[build] screen helper skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
