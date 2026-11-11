#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { z } from "zod";
import {
  bundleDaemon,
  linuxScreenHelperName,
  RustToolchainError,
  stageLinuxScreenHelper,
} from "@ace/release";
import { stageBunRuntime } from "@ace/release/daemon-runtime";
import { stageSpadeServer } from "@ace/release/spade-server";
import { ReleaseTarget } from "@ace/protocol";
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
import { mainProcessNeedsKoffi, stageMainProcessNatives } from "./koffi.ts";
import { stageLockedUse } from "./locked-use.ts";
import { verifyNatives } from "./verify-natives.ts";

/**
 * Builds everything the packaged app ships, into `apps/desktop/dist`:
 * - `app/`: main, preload, the web renderer and the app's package.json (becomes app.asar);
 * - `node_modules/` (Windows only): koffi with this target's prebuilt binary, for the main
 *   process (scripts/koffi.ts; the standalone daemon ships none);
 * - `daemon/`: the daemon bundle from `@ace/release`, its worker bundles, staged runtime
 *   packages (playwright-core, the Claude SDK), `descriptor.node` and `desktop-app.json` (the app's version, so the bundled `ace update` defers to the app);
 * - `helpers/`: the screen helper for this platform;
 * - `bin/rg`: ripgrep for workspace search;
 * - `spade/`: Spade's server (`spade-server`), unless `DISABLE_SPADE=1`;
 * - `runtime/`: the pinned Bun runtime the daemon runs on.
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

if (mainProcessNeedsKoffi(process.platform)) log("koffi");
await stageMainProcessNatives(dist, process.platform, arch);

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
await copyFile(join(repo, "LICENSE"), join(daemon, "ACE-LICENSE"));
// The bundled CLI's `ace update` hands the update to the app instead (ADR 0091).
await writeFile(
  join(daemon, desktopAppMarker),
  JSON.stringify(DesktopApp.parse({ version: appVersion })) + "\n",
);

// Spade's server, copied out to <ACE_HOME>/releases/spade on install (ADR 0123).
log("spade-server");
log(
  `spade-server: ${await stageSpadeServer({
    repo,
    root: dist,
    target: ReleaseTarget.parse(`${process.platform}-${arch}`),
    version: appVersion,
    env: process.env,
  })}`,
);

log("ripgrep");
await stageRipgrep(join(dist, "bin"));

log("screen helper");
await stageScreenHelper(join(dist, "helpers"));

if (process.platform === "darwin" && process.env.ACE_SCREEN_SIGN_RELEASE === "1") {
  log("locked-use components");
  await stageLockedUse(repo, join(dist, "locked-use"));
}

// The Windows installer runs this on the bundled Node for PATH, the `ace` command and
// uninstall cleanup (src/packaging/setup.ts, build/installer.nsh).
if (process.platform === "win32") {
  log("installer helper");
  await build({
    entryPoints: [join(desktop, "src/packaging/setup-entry.ts")],
    outfile: join(dist, "setup/ace-setup.mjs"),
    bundle: true,
    minify: true,
    platform: "node",
    target: "node26",
    format: "esm",
    legalComments: "eof",
    logLevel: "warning",
    banner: {
      js: 'import { createRequire as __aceCreateRequire } from "node:module"; const require = __aceCreateRequire(import.meta.url);',
    },
  });
}

const releaseTarget = `${process.platform}-${arch}`;
if (
  releaseTarget === "darwin-arm64" ||
  releaseTarget === "darwin-x64" ||
  releaseTarget === "linux-arm64" ||
  releaseTarget === "linux-x64"
) {
  log("bun runtime");
  const runtime = join(dist, "runtime");
  await stageBunRuntime({
    target: releaseTarget,
    cacheDir: join(desktop, "node_modules/.cache/ace-runtime"),
    executable: join(runtime, "bin", "node"),
    licensePath: join(runtime, "LICENSE"),
  });
} else if (releaseTarget === "win32-x64" || releaseTarget === "win32-arm64") {
  log("bun runtime");
  await stageBunRuntime({
    target: releaseTarget,
    cacheDir: join(desktop, "node_modules/.cache/ace-runtime"),
    executable: join(dist, "runtime", "node.exe"),
    licensePath: join(dist, "runtime", "LICENSE"),
  });
}

log(`native code for ${process.platform}-${arch}`);
await verifyNatives(arch);
log(`done: ${dist}`);

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
 * A missing toolchain skips the helper with a warning; screen use is then unavailable. On
 * Linux a Rust older than the crate's `rust-version` fails the build: that toolchain is there
 * to be used, so a package quietly without screen use would be a mistake. A release package
 * (`ACE_REQUIRE_SCREEN_HELPER=1`) fails on any reason.
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
    if (error instanceof RustToolchainError && error.reason === "too-old") throw error;
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      [
        "",
        "[build] ************************************************************************",
        "[build] SCREEN HELPER SKIPPED: this build cannot see or use the screen.",
        `[build] ${reason}`,
        "[build] Set ACE_REQUIRE_SCREEN_HELPER=1 to make this an error.",
        "[build] ************************************************************************",
        "",
      ].join("\n"),
    );
  }
}
