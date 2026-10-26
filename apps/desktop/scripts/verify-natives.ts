import { existsSync } from "node:fs";
import { join } from "node:path";
import { mismatchedBinaries, type Arch } from "@ace/release/native-arch";
import { dist } from "./common.ts";
import { windowsRuntimePaths } from "@ace/release/node-runtime";

/**
 * Never ship a package whose native code cannot run: each required piece must be present,
 * and no staged binary may be built for another architecture.
 */
export async function verifyNatives(arch: Arch): Promise<void> {
  const ptyRoot = join(dist, "daemon/node_modules/node-pty");
  // Windows runs no local daemon yet (no descriptor.node), so it ships no runtime either.
  const required = [
    join(dist, "bin", process.platform === "win32" ? "rg.exe" : "rg"),
    ...(process.platform === "win32"
      ? [windowsRuntimePaths(join(dist, "runtime")).exePath]
      : [
          join(dist, "daemon/descriptor.node"),
          // Every terminal the daemon opens starts this guardian.
          join(dist, "daemon/group-keeper"),
          join(dist, "runtime/bin/node"),
        ]),
  ];
  const problems = required.filter((path) => !existsSync(path)).map((path) => `missing ${path}`);
  if (process.platform === "win32") {
    // The ConPTY backend needs conpty.node with conpty/conpty.dll beside it, and its workers.
    const pairs = ["build/Release", "build/Debug", `prebuilds/win32-${arch}`].map((base) => [
      join(ptyRoot, base, "conpty.node"),
      join(ptyRoot, base, "conpty", "conpty.dll"),
    ]);
    if (!pairs.some((pair) => pair.every((path) => existsSync(path))))
      problems.push(`missing node-pty ConPTY module or dll for ${arch}`);
    for (const worker of ["lib/worker/conoutSocketWorker.js", "lib/shared/conout.js"])
      if (!existsSync(join(ptyRoot, worker))) problems.push(`missing ${join(ptyRoot, worker)}`);
  }
  const pty = [
    join(ptyRoot, "build/Release/pty.node"),
    join(ptyRoot, "prebuilds", `${process.platform}-${arch}`, "pty.node"),
  ];
  if (process.platform !== "win32" && !pty.some((path) => existsSync(path)))
    problems.push(`missing node-pty for ${arch}`);
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
