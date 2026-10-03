import { cp, mkdir, stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { ReleaseTarget } from "@ace/protocol";

/** The bundler owns runtime dependencies, including the native PTY now used at startup. */
export async function stagePtyRuntime(repo: string, root: string, target: string): Promise<string> {
  const platform = ReleaseTarget.parse(target);
  const installed = join(repo, "tools/release/node_modules/node-pty");
  const destination = join(root, "node_modules/node-pty");
  await mkdir(destination, { recursive: true });
  for (const name of ["lib", "package.json", "LICENSE"])
    await cp(join(installed, name), join(destination, name), { recursive: true });
  const native = join(destination, "prebuilds", platform);
  // Full releases stage checksum-verified native inputs before bundling. Keep them.
  if (await regularFile(join(native, "pty.node"))) return join(installed, "package.json");
  if (platform !== `${process.platform}-${process.arch}`)
    throw new Error(`Stage target-native node-pty inputs before bundling ${platform}`);
  // Local bundle callers use the installed native runtime, including Linux source builds.
  const candidates = ["build/Release", "build/Debug", `prebuilds/${platform}`];
  const source = await firstNative(installed, candidates);
  await mkdir(native, { recursive: true });
  await cp(join(source, "pty.node"), join(native, "pty.node"));
  if (platform.startsWith("darwin-")) {
    await cp(join(source, "spawn-helper"), join(native, "spawn-helper"));
    await chmod(join(native, "spawn-helper"), 0o755);
  }
  return join(installed, "package.json");
}
async function firstNative(root: string, candidates: string[]): Promise<string> {
  for (const path of candidates)
    if (await regularFile(join(root, path, "pty.node"))) return join(root, path);
  throw new Error("Installed node-pty has no native runtime; run bun install before bundling");
}
async function regularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
