import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const main = resolve(import.meta.dirname, "main.ts");
/** The repository's recordings for each provider the fake CLI speaks. */
export const recordings = {
  claude: resolve(import.meta.dirname, "../../../../fixtures/claude/2.1.286"),
};
export type FakeProvider = keyof typeof recordings;
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
/**
 * Writes an executable named after the provider into `bin`. It runs the fake through this
 * Node binary by absolute path, so the daemon's PATH can hold the fake bin directory alone.
 */
export async function installFakeCli(bin: string, provider: FakeProvider, node = process.execPath) {
  await mkdir(bin, { recursive: true });
  const path = join(bin, provider);
  await writeFile(
    path,
    `#!/bin/sh\nexec ${quote(node)} --no-warnings ${quote(main)} ${provider} "$@"\n`,
  );
  await chmod(path, 0o755);
  return path;
}
