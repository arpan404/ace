import { cp, mkdir, stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { ReleaseTarget } from "@ace/protocol";
import { copyRuntimePackage } from "./copy-runtime-package.ts";
import {
  isWindowsDesktopRuntimeTarget,
  type WindowsDesktopRuntimeTarget,
} from "./windows-node-files.ts";

type PosixPtyTarget = z.infer<typeof ReleaseTarget>;
export type PtyRuntimeTarget = PosixPtyTarget | WindowsDesktopRuntimeTarget;

/**
 * Parses standalone POSIX targets plus bounded Windows desktop targets without
 * changing the protocol `ReleaseTarget` schema (standalone updater/archives stay
 * POSIX-only; Windows uses the separate union owned by `windows-node-files.ts`).
 */
export function parsePtyRuntimeTarget(value: string): PtyRuntimeTarget {
  const posix = ReleaseTarget.safeParse(value);
  if (posix.success) return posix.data;
  if (isWindowsDesktopRuntimeTarget(value)) return value;
  throw new Error(`Unsupported PTY target ${value}`);
}

/**
 * Bounded Windows ConPTY closure for the `useConptyDll:true` backend
 * (`packages/terminal/src/pty.ts`). Derived from node-pty 1.1.0
 * `lib/windowsPtyAgent.js`, `lib/windowsConoutConnection.js` and
 * `src/win/conpty.cc` (`LoadConptyDll`):
 * - `conpty.node` loaded via `utils.loadNativeModule('conpty')`
 * - `conpty/conpty.dll` loaded relative to that module (`conpty\conpty.dll`)
 * - `lib/worker/conoutSocketWorker.js` plus `lib/shared/conout.js` for output
 *
 * `pty.node`, `winpty.dll`/`winpty-agent.exe` and `conpty_console_list.node`
 * serve only fallback paths (`useConpty:false`, `useConptyDll:false`) the
 * backend never takes, and `OpenConsole.exe`/`.pdb` files are a demo console
 * and debug symbols. None are staged. Architecture validation stays with the existing owner
 * (`apps/desktop/src/packaging/native-arch.ts`); this module does no PE parsing.
 */
const windowsConptyModule = "conpty.node";
const windowsConptyDll = join("conpty", "conpty.dll");
const windowsWorkerFiles = [
  join("lib", "worker", "conoutSocketWorker.js"),
  join("lib", "shared", "conout.js"),
] as const;

/**
 * Shared stager for the release bundle and the desktop app. `source` is the
 * installed node-pty root, `destination` is `.../node_modules/node-pty`.
 * No duplicate logic lives in desktop `build.ts`.
 */
export async function stagePtyFiles(
  source: string,
  destination: string,
  target: string,
): Promise<void> {
  const platform = parsePtyRuntimeTarget(target);
  await mkdir(destination, { recursive: true });
  await copyRuntimePackage(join(source, "lib"), join(destination, "lib"));
  for (const name of ["package.json", "LICENSE"])
    await cp(join(source, name), join(destination, name), { recursive: true });
  if (isWindowsDesktopRuntimeTarget(platform)) {
    await stageWindowsConpty(source, destination, platform);
    return;
  }
  await stagePosixNative(source, destination, platform);
}

/** The bundler owns runtime dependencies, including the native PTY now used at startup. */
export async function stagePtyRuntime(repo: string, root: string, target: string): Promise<string> {
  const installed = join(repo, "tools/release/node_modules/node-pty");
  const destination = join(root, "node_modules/node-pty");
  await stagePtyFiles(installed, destination, target);
  return join(installed, "package.json");
}

async function stagePosixNative(
  source: string,
  destination: string,
  platform: PosixPtyTarget,
): Promise<void> {
  const native = join(destination, "prebuilds", platform);
  // Full releases stage checksum-verified native inputs before bundling. Keep them.
  if (await regularFile(join(native, "pty.node"))) return;
  if (platform !== `${process.platform}-${process.arch}`)
    throw new Error(`Stage target-native node-pty inputs before bundling ${platform}`);
  // Local bundle callers use the installed native runtime, including Linux source builds.
  const candidates = ["build/Release", "build/Debug", `prebuilds/${platform}`];
  const from = await firstNative(source, candidates);
  await mkdir(native, { recursive: true });
  await cp(join(from, "pty.node"), join(native, "pty.node"));
  if (platform.startsWith("darwin-")) {
    await cp(join(from, "spawn-helper"), join(native, "spawn-helper"));
    await chmod(join(native, "spawn-helper"), 0o755);
  }
}

async function stageWindowsConpty(
  source: string,
  destination: string,
  target: WindowsDesktopRuntimeTarget,
): Promise<void> {
  for (const file of windowsWorkerFiles)
    if (!(await regularFile(join(source, file))))
      throw new Error(
        `Installed node-pty is missing required ConPTY worker ${file}; run bun install before bundling`,
      );
  const destNative = join(destination, "prebuilds", target);
  // Full releases stage checksum-verified native inputs before bundling. Keep them.
  if (
    (await regularFile(join(destNative, windowsConptyModule))) &&
    (await regularFile(join(destNative, windowsConptyDll)))
  )
    return;
  // Windows prebuilds are portable copies (no build, no chmod), so any host can
  // stage them. Rebuilt `build/Release` wins when complete, else the prebuild.
  // The destination always uses the prebuild layout the loader also checks.
  const candidates =
    target === `${process.platform}-${process.arch}`
      ? ["build/Release", "build/Debug", `prebuilds/${target}`]
      : [`prebuilds/${target}`];
  for (const candidate of candidates) {
    const module = join(source, candidate, windowsConptyModule);
    const dll = join(source, candidate, windowsConptyDll);
    if ((await regularFile(module)) && (await regularFile(dll))) {
      await mkdir(join(destNative, "conpty"), { recursive: true });
      await cp(module, join(destNative, windowsConptyModule));
      await cp(dll, join(destNative, windowsConptyDll));
      return;
    }
  }
  throw new Error(
    `Installed node-pty is missing required ConPTY module or dll for ${target}; run bun install before bundling`,
  );
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
