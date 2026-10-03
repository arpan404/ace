import { existsSync } from "node:fs";
import { join } from "node:path";
import { mismatchedBinaries, type Arch } from "../src/packaging/native-arch.ts";
import { dist } from "./common.ts";

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
      ? []
      : [join(dist, "daemon/descriptor.node"), join(dist, "runtime/bin/node")]),
  ];
  const problems = required.filter((path) => !existsSync(path)).map((path) => `missing ${path}`);
  const pty = [
    join(ptyRoot, "build/Release/pty.node"),
    join(ptyRoot, "prebuilds", `${process.platform}-${arch}`, "pty.node"),
  ];
  if (!pty.some((path) => existsSync(path))) problems.push(`missing node-pty for ${arch}`);
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
