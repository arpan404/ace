import { existsSync } from "node:fs";
import { join } from "node:path";
import { mismatchedBinaries, type Arch } from "@ace/release/native-arch";
import { dist as builtDist } from "./common.ts";
import { koffiBinary, koffiLicense, mainProcessNeedsKoffi } from "./koffi.ts";

/**
 * Never ship a package whose native code cannot run: each required piece must be present,
 * and no staged binary may be built for another architecture. Checks the build in `dist`
 * for `platform` (this machine's build by default).
 */
export async function verifyNatives(
  arch: Arch,
  platform: NodeJS.Platform = process.platform,
  dist = builtDist,
): Promise<void> {
  // Windows terminals need no guardian: a Job Object owns them (ADR 0095).
  const required = [
    join(dist, "media", platform === "win32" ? "ace-media.exe" : "ace-media"),
    join(dist, "bin", platform === "win32" ? "rg.exe" : "rg"),
    // The Windows main process's tree stop and Job Objects bind kernel32 through it.
    ...(mainProcessNeedsKoffi(platform)
      ? [
          koffiBinary(join(dist, "node_modules"), platform, arch),
          koffiLicense(join(dist, "node_modules")),
        ]
      : []),
    ...(platform === "win32"
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
    ["daemon", "node_modules", "bin", "helpers", "runtime", "spade", "media"]
      .map((name) => join(dist, name))
      .filter((path) => existsSync(path)),
    platform,
    arch,
  ))
    problems.push(`${found.path} is ${found.arches.join("+")}, not ${arch}`);
  if (problems.length)
    throw new Error(`The ${arch} package would not run:\n  ${problems.join("\n  ")}`);
}
