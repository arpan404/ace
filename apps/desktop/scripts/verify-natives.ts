import { existsSync } from "node:fs";
import { join } from "node:path";
import { mismatchedBinaries, type Arch } from "@ace/release/native-arch";
import { dist } from "./common.ts";

/**
 * Never ship a package whose native code cannot run: each required piece must be present,
 * and no staged binary may be built for another architecture.
 */
export async function verifyNatives(arch: Arch): Promise<void> {
  // Windows terminals need no guardian: a Job Object owns them (ADR 0095).
  const required = [
    join(dist, "bin", process.platform === "win32" ? "rg.exe" : "rg"),
    ...(process.platform === "win32"
      ? [join(dist, "runtime", "node.exe"), join(dist, "daemon/descriptor.node")]
      : [
          join(dist, "daemon/descriptor.node"),
          // Every terminal the daemon opens starts this guardian.
          join(dist, "daemon/group-keeper"),
          join(dist, "runtime/bin/node"),
        ]),
  ];
  const problems = required.filter((path) => !existsSync(path)).map((path) => `missing ${path}`);
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
