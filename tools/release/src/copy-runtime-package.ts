import { cp, mkdir } from "node:fs/promises";
import { basename } from "node:path";

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

export async function copyRuntimePackage(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true, dereference: false, filter: shipsAtRuntime });
}
