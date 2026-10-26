import { cp, mkdir, stat, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { copyRuntimePackage } from "./copy-runtime-package.ts";
import { isWindowsTarget, runtimeTarget, type RuntimeTarget } from "./node-runtime.ts";

// The `useConptyDll` backend loads conpty.node, conpty/conpty.dll beside it and the conout
// worker; winpty and the other fallback files are never staged.
const windowsWorkerFiles = [
  join("lib", "worker", "conoutSocketWorker.js"),
  join("lib", "shared", "conout.js"),
] as const;

/** Stages node-pty for the release bundle and the desktop app into `.../node_modules/node-pty`. */
export async function stagePtyFiles(
  source: string,
  destination: string,
  target: string,
): Promise<void> {
  const platform = runtimeTarget(target);
  if (!platform) throw new Error(`Unsupported PTY target ${target}`);
  await mkdir(destination, { recursive: true });
  await copyRuntimePackage(join(source, "lib"), join(destination, "lib"));
  for (const name of ["package.json", "LICENSE"])
    await cp(join(source, name), join(destination, name), { recursive: true });
  await stageNative(source, destination, platform);
}

/** The bundler owns runtime dependencies, including the native PTY now used at startup. */
export async function stagePtyRuntime(repo: string, root: string, target: string): Promise<string> {
  const installed = join(repo, "tools/release/node_modules/node-pty");
  const destination = join(root, "node_modules/node-pty");
  await stagePtyFiles(installed, destination, target);
  return join(installed, "package.json");
}

async function stageNative(
  source: string,
  destination: string,
  target: RuntimeTarget,
): Promise<void> {
  const windows = isWindowsTarget(target);
  if (windows)
    for (const file of windowsWorkerFiles)
      if (!(await regularFile(join(source, file))))
        throw new Error(`Installed node-pty is missing its ConPTY worker ${file}; run bun install`);
  const required = windows ? ["conpty.node", join("conpty", "conpty.dll")] : ["pty.node"];
  const files = target.startsWith("darwin-") ? [...required, "spawn-helper"] : required;
  const native = join(destination, "prebuilds", target);
  // Full releases stage checksum-verified native inputs before bundling. Keep them.
  if (await allFiles(native, required)) return;
  const host = target === `${process.platform}-${process.arch}`;
  // Windows prebuilds are portable copies, so any host can stage them; POSIX ones are not.
  if (!host && !windows)
    throw new Error(`Stage target-native node-pty inputs before bundling ${target}`);
  const candidates = host
    ? ["build/Release", "build/Debug", `prebuilds/${target}`]
    : [`prebuilds/${target}`];
  for (const candidate of candidates) {
    if (!(await allFiles(join(source, candidate), files))) continue;
    for (const file of files) {
      await mkdir(dirname(join(native, file)), { recursive: true });
      await cp(join(source, candidate, file), join(native, file));
    }
    if (files.includes("spawn-helper")) await chmod(join(native, "spawn-helper"), 0o755);
    return;
  }
  throw new Error(
    `Installed node-pty is missing ${files.join(", ")} for ${target}; run bun install before bundling`,
  );
}
async function allFiles(root: string, files: readonly string[]): Promise<boolean> {
  for (const file of files) if (!(await regularFile(join(root, file)))) return false;
  return true;
}
async function regularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
