import { cp, mkdir } from "node:fs/promises";
import { basename, join, sep } from "node:path";

/** TypeScript sources and source maps: never run or loaded from an installed package. */
const typeScriptOrMap = /\.(?:[cm]?ts|map)$/;
/** C, C++ and assembly sources and build files for compiling from source; releases ship prebuilt binaries. */
const nativeSource = /\.(?:c|cc|cpp|h|hh|hpp|inc|def|S|asm|gyp|gypi)$/;
/** Notices stay with their package, whatever their extension. */
const notice = /^(?:licen[cs]e|notice|copying)/i;

/**
 * Runtime JS, native helpers and notices remain intact; files nothing loads at runtime do not
 * ship. Every file is an entry in the daemon archive, and installed updaters refuse an archive
 * over their entry budget (`releaseArchiveLimits` in `@ace/service`).
 */
export function shipsAtRuntime(path: string): boolean {
  const name = basename(path);
  if (name === "node_modules") return false;
  if (notice.test(name)) return true;
  return !typeScriptOrMap.test(name) && !nativeSource.test(name) && !name.endsWith(".md");
}

/**
 * Copies a package's runtime files, leaving out `unused`: folders inside the package, relative to
 * its root, that nothing loads at run time.
 */
export async function copyRuntimePackage(
  source: string,
  destination: string,
  unused: readonly string[] = [],
): Promise<void> {
  const left = unused.map((folder) => join(source, folder));
  const ships = (path: string) =>
    shipsAtRuntime(path) &&
    !left.some((folder) => path === folder || path.startsWith(folder + sep));
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true, dereference: false, filter: ships });
}
