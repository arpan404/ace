import { cp, mkdir } from "node:fs/promises";
import { basename } from "node:path";

/**
 * Runtime JS, native helpers and notices remain intact; compiler-only files do not ship.
 * TypeScript sources (`.ts`, `.d.ts`, …) never run from a package and source maps are not
 * loaded, so both are left out to keep the archive inside the updater's entry budget.
 */
export async function copyRuntimePackage(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    filter: (path) => basename(path) !== "node_modules" && !/\.(?:[cm]?ts|map)$/.test(path),
  });
}
