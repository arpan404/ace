import { realpath, mkdir, lstat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), path.slice(parent.length));
  }
}
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return !rel || (!rel.startsWith("..") && !rel.startsWith("/"));
}
/** Reject aliases before any output writes, including error-report writes. */
export async function prepareOutput(out: string, source: string): Promise<string> {
  const target = await canonical(resolve(out));
  for (const protectedHome of [source, join(homedir(), ".ace-next")])
    if (inside(await canonical(resolve(protectedHome)), target))
      throw new Error("Output must be outside ace source homes");
  await mkdir(target, { recursive: true, mode: 0o700 });
  const screenshots = join(target, "screenshots");
  await mkdir(screenshots, { recursive: true, mode: 0o700 });
  if ((await realpath(screenshots)) !== screenshots)
    throw new Error("Screenshot directory is redirected");
  return target;
}
export async function refuseSymlink(path: string) {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Artifact path is redirected");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
