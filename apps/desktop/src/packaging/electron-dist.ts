import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * The Electron executable of the `electron` package that `packageJson`'s directory resolves.
 *
 * Since Electron 40 the package has no postinstall: it downloads its binary the first time
 * it is required. Requiring it here is what fetches the binary on a fresh install.
 */
export function electronBinary(packageJson: string): string {
  const path: unknown = createRequire(packageJson)("electron");
  if (typeof path !== "string")
    throw new Error("The electron package did not return a binary path");
  return path;
}

/**
 * The installed Electron build (`node_modules/electron/dist`) that a local package reuses
 * instead of downloading Electron again. Fetches the binary first when a fresh install has
 * not downloaded it yet.
 */
export function electronDist(packageJson: string): string {
  electronBinary(packageJson);
  const dist = join(dirname(createRequire(packageJson).resolve("electron/package.json")), "dist");
  if (!existsSync(dist)) throw new Error(`The electron package has no downloaded build at ${dist}`);
  return dist;
}
