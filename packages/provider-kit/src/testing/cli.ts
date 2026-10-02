import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Keep extensionless Node stand-ins in CommonJS even beneath an ESM package. */
export async function nodeBinary(root: string, name: string, source: string) {
  await writeFile(join(root, "package.json"), '{"type":"commonjs"}\n');
  const path = join(root, name);
  await writeFile(path, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  return path;
}
