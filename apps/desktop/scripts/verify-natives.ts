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
  // Windows runs no local daemon yet (no descriptor.node), only the Node runtime foundation.
  const windowsRuntime = windowsRuntimePaths(join(dist, "runtime"));
  const required = [
    join(dist, "bin", process.platform === "win32" ? "rg.exe" : "rg"),
    ...(process.platform === "win32"
      ? [windowsRuntime.exePath]
      : [
          join(dist, "daemon/descriptor.node"),
          // Every terminal the daemon opens starts this guardian.
          join(dist, "daemon/group-keeper"),
          join(dist, "runtime/bin/node"),
        ]),
  ];
  const problems = required.filter((path) => !existsSync(path)).map((path) => `missing ${path}`);
  // Windows ConPTY closure for the `useConptyDll:true` backend: `conpty.node` plus
  // the `conpty/conpty.dll` its loader resolves beside it, and the conout worker
  // files. Fallback `pty.node`/`winpty` files are not staged. Architecture is
  // validated below by the existing `mismatchedBinaries` owner (no PE duplication).
  if (process.platform === "win32") {
    const target = `win32-${arch}`;
    const pairs: Array<[string, string]> = [
      join(ptyRoot, "build/Release"),
      join(ptyRoot, "build/Debug"),
      join(ptyRoot, "prebuilds", target),
    ].map((base) => [join(base, "conpty.node"), join(base, "conpty", "conpty.dll")]);
    if (!pairs.some(([module, dll]) => existsSync(module) && existsSync(dll)))
      problems.push(`missing node-pty ConPTY module or dll for ${arch}`);
    for (const worker of ["lib/worker/conoutSocketWorker.js", "lib/shared/conout.js"])
      if (!existsSync(join(ptyRoot, worker))) problems.push(`missing ${join(ptyRoot, worker)}`);
  } else {
    const pty = [
      join(ptyRoot, "build/Release/pty.node"),
      join(ptyRoot, "prebuilds", `${process.platform}-${arch}`, "pty.node"),
    ];
    if (!pty.some((path) => existsSync(path))) problems.push(`missing node-pty for ${arch}`);
  }
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
