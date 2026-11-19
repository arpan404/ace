import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { copyRuntimePackage } from "@ace/release/runtime-package";
import { desktop } from "./common.ts";

/**
 * koffi ships with the Windows desktop app, never with the standalone daemon (which binds
 * native code with bun:ffi) and never on macOS or Linux, where nothing calls it. The main
 * process and its probe worker run on Electron's Node and bind kernel32 through it: the
 * System32 lookup behind the taskkill tree stop and Job Object containment
 * (`@ace/provider-kit/koffi`).
 *
 * It is staged as plain packages in a `node_modules` folder that the package places beside
 * app.asar (`copyBesideApp` in beside-app.ts). Native code cannot load from inside the
 * archive, and Node finds that folder by walking up from both main's chunks in app.asar and
 * the worker bundles in app.asar.unpacked.
 */

/** koffi's prebuilt package for one OS and architecture. */
export function koffiPlatformPackage(platform: NodeJS.Platform, arch: string): string {
  return `@koromix/koffi-${platform}-${arch}`;
}

/**
 * The binary koffi loads for a target, in a staged `node_modules`. On Linux it is the glibc
 * build; the package also carries a musl one, which Electron never uses.
 */
export function koffiBinary(nodeModules: string, platform: NodeJS.Platform, arch: string): string {
  return join(
    nodeModules,
    koffiPlatformPackage(platform, arch),
    `${platform}_${arch}`,
    "koffi.node",
  );
}

/** The license koffi ships under (MIT), kept in its staged package. */
export function koffiLicense(nodeModules: string): string {
  return join(nodeModules, "koffi", "LICENSE.txt");
}

/** Only Windows binds kernel32 through koffi; macOS and Linux packages carry none. */
export function mainProcessNeedsKoffi(platform: string): boolean {
  return platform === "win32";
}

/** The build's koffi step: stages it into `dist/node_modules` for a Windows package only. */
export async function stageMainProcessNatives(
  dist: string,
  platform: NodeJS.Platform,
  arch: string,
  from = desktop,
): Promise<void> {
  if (mainProcessNeedsKoffi(platform))
    await stageKoffi(join(dist, "node_modules"), platform, arch, from);
}

/**
 * Copies koffi and its prebuilt binary for a target into `nodeModules`, resolved from the
 * package in `from` (the desktop package's own dependency by default). Only the host's
 * prebuilt package is installed, so a target other than the host fails here, like the rest
 * of the build's native code.
 */
export async function stageKoffi(
  nodeModules: string,
  platform: NodeJS.Platform,
  arch: string,
  from = desktop,
): Promise<void> {
  const entry = createRequire(join(from, "package.json")).resolve("koffi");
  const root = packageRoot(entry);
  const prebuilt = koffiPlatformPackage(platform, arch);
  let prebuiltEntry: string;
  try {
    prebuiltEntry = createRequire(entry).resolve(prebuilt);
  } catch (error) {
    throw new Error(`${prebuilt} is not installed; build the ${platform}-${arch} app there`, {
      cause: error,
    });
  }
  await copyRuntimePackage(root, join(nodeModules, "koffi"));
  await copyRuntimePackage(packageRoot(prebuiltEntry), join(nodeModules, prebuilt));
  for (const path of [koffiBinary(nodeModules, platform, arch), koffiLicense(nodeModules)])
    if (!existsSync(path)) throw new Error(`koffi staged without ${path}`);
}

/** The folder holding the package.json nearest to `file`. */
function packageRoot(file: string): string {
  let directory = dirname(file);
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`No package.json above ${file}`);
    directory = parent;
  }
  return directory;
}
