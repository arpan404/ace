import { existsSync } from "node:fs";
import { join } from "node:path";
import { mismatchedBinaries, type Arch } from "@ace/release/native-arch";
import { dist } from "./common.ts";

/**
 * Never ship a package whose native code cannot run: each required piece must be present,
 * and no staged binary may be built for another architecture.
 */
export async function verifyNatives(arch: Arch): Promise<void> {
  const ptyRoot = join(dist, "daemon/node_modules/node-pty");
  // Windows runs no local daemon yet (no descriptor.node); it ships only the Node runtime.
  const required = [
    join(dist, "bin", process.platform === "win32" ? "rg.exe" : "rg"),
    ...(process.platform === "win32"
      ? [join(dist, "runtime", "node.exe")]
      : [
          join(dist, "daemon/descriptor.node"),
          // Every terminal the daemon opens starts this guardian.
          join(dist, "daemon/group-keeper"),
          join(dist, "runtime/bin/node"),
        ]),
  ];
  const problems = required.filter((path) => !existsSync(path)).map((path) => `missing ${path}`);
  const pty = [
    join(ptyRoot, "build/Release/pty.node"),
    join(ptyRoot, "prebuilds", `${process.platform}-${arch}`, "pty.node"),
    // Windows loads the ConPTY module instead of pty.node.
    ...(process.platform === "win32" ? windowsPtyModules(ptyRoot, arch) : []),
  ];
  if (!pty.some((path) => existsSync(path))) problems.push(`missing node-pty for ${arch}`);
  if (process.platform === "win32") problems.push(...windowsPtyProblems(ptyRoot, arch));
  const koffi = join(dist, "daemon/node_modules/@koromix", `koffi-${process.platform}-${arch}`);
  if (existsSync(join(dist, "daemon/node_modules/koffi")) && !existsSync(koffi))
    problems.push(`missing ${koffi}`);
  for (const found of await mismatchedBinaries(
    ["daemon", "bin", "helpers", "runtime"]
      .map((name) => join(dist, name))
      .filter((path) => existsSync(path)),
    process.platform,
    arch,
  ))
    problems.push(`${found.path} is ${found.arches.join("+")}, not ${arch}`);
  if (problems.length)
    throw new Error(`The ${arch} package would not run:\n  ${problems.join("\n  ")}`);
}

/** Windows only: where node-pty's ConPTY module may live. */
function windowsPtyModules(ptyRoot: string, arch: Arch): string[] {
  return ["build/Release", "build/Debug", `prebuilds/win32-${arch}`].map((base) =>
    join(ptyRoot, base, "conpty.node"),
  );
}

/**
 * Windows only: node-pty's ConPTY dll backend needs conpty/conpty.dll and the OpenConsole.exe it
 * hosts beside the module, plus the conout worker.
 */
function windowsPtyProblems(ptyRoot: string, arch: Arch): string[] {
  const problems: string[] = [];
  const complete = windowsPtyModules(ptyRoot, arch).some((module) =>
    ["conpty.dll", "OpenConsole.exe"].every((file) =>
      existsSync(join(module, "..", "conpty", file)),
    ),
  );
  if (!complete) problems.push(`missing node-pty conpty.dll or OpenConsole.exe for ${arch}`);
  for (const worker of ["lib/worker/conoutSocketWorker.js", "lib/shared/conout.js"])
    if (!existsSync(join(ptyRoot, worker))) problems.push(`missing ${join(ptyRoot, worker)}`);
  return problems;
}
