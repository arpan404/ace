import { cp, mkdir } from "node:fs/promises";
import { basename } from "node:path";

/** Runtime JS, native helpers and notices remain intact; compiler-only files do not ship. */
export async function copyRuntimePackage(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    filter: (path) =>
      basename(path) !== "node_modules" && !/(?:\.d\.(?:ts|cts|mts)|\.map)$/.test(path),
  });
}
