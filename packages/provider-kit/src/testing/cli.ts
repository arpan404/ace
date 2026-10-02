import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Scheduling allowance for real process/socket tests, not a performance target. */
export const PROCESS_TEST_TIMEOUT = 120_000;

declare module "vitest" {
  export interface ProvidedContext {
    daemonCli: string;
    tlsHome: string;
    gitTemplate: string;
  }
}

/** Keep extensionless Node stand-ins in CommonJS even beneath an ESM package. */
export async function nodeBinary(root: string, name: string, source: string) {
  await writeFile(join(root, "package.json"), '{"type":"commonjs"}\n');
  const path = join(root, name);
  await writeFile(path, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  return path;
}
