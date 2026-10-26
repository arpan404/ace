import { cp, mkdir, stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { ReleaseTarget } from "@ace/protocol";
import { copyRuntimePackage } from "./copy-runtime-package.ts";
import { isWindowsTarget, type WindowsTarget } from "./node-runtime.ts";

/** The bundler owns runtime dependencies, including the native PTY now used at startup. */
export async function stagePtyRuntime(repo: string, root: string, target: string): Promise<string> {
  if (isWindowsTarget(target)) {
    const installed = join(repo, "tools/release/node_modules/node-pty");
    await stageWindowsPty(installed, join(root, "node_modules/node-pty"), target);
    return join(installed, "package.json");
  }
  const platform = ReleaseTarget.parse(target);
  const installed = join(repo, "tools/release/node_modules/node-pty");
  const destination = join(root, "node_modules/node-pty");
  await mkdir(destination, { recursive: true });
  await copyRuntimePackage(join(installed, "lib"), join(destination, "lib"));
  for (const name of ["package.json", "LICENSE"])
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

// Windows uses node-pty's `useConptyDll` backend: conpty.node, conpty/conpty.dll beside it and
// the conout worker. winpty and the other fallback files are never staged.
const windowsNatives = ["conpty.node", join("conpty", "conpty.dll")];
const windowsWorkers = [
  join("lib", "worker", "conoutSocketWorker.js"),
  join("lib", "shared", "conout.js"),
];

/** Stages node-pty for a Windows target from the installed package at `source`. */
export async function stageWindowsPty(
  source: string,
  destination: string,
  target: WindowsTarget,
): Promise<void> {
  for (const file of windowsWorkers)
    if (!(await regularFile(join(source, file))))
      throw new Error(`Installed node-pty is missing its ConPTY worker ${file}; run bun install`);
  await mkdir(destination, { recursive: true });
  await copyRuntimePackage(join(source, "lib"), join(destination, "lib"));
  for (const name of ["package.json", "LICENSE"])
    await cp(join(source, name), join(destination, name), { recursive: true });
  const native = join(destination, "prebuilds", target);
  // Full releases stage checksum-verified native inputs before bundling. Keep them.
  if (await allFiles(native)) return;
  // Windows prebuilds are portable copies, so any host can stage them.
  const candidates =
    target === `${process.platform}-${process.arch}`
      ? ["build/Release", "build/Debug", `prebuilds/${target}`]
      : [`prebuilds/${target}`];
  for (const candidate of candidates) {
    if (!(await allFiles(join(source, candidate)))) continue;
    await mkdir(join(native, "conpty"), { recursive: true });
    for (const file of windowsNatives) await cp(join(source, candidate, file), join(native, file));
    return;
  }
  throw new Error(`Installed node-pty is missing the ConPTY module or dll for ${target}`);
}
async function allFiles(root: string): Promise<boolean> {
  for (const file of windowsNatives) if (!(await regularFile(join(root, file)))) return false;
  return true;
}
