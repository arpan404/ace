import { realpath } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { contains } from "@ace/native-session";
import type { ProviderHome } from "./contracts.ts";

// Resolve missing descendants through their nearest existing parent before creating anything.
async function prospectivePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await prospectivePath(parent), basename(path));
  }
}
export async function validateIndexPath(path: string, instances: ProviderHome[]) {
  const parent = await prospectivePath(dirname(path));
  for (const instance of instances) {
    const home = await prospectivePath(instance.homeDir);
    if (contains(home, parent)) throw new Error("ace index must be outside provider homes");
  }
}
