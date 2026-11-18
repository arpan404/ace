import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { mismatchedBinaries, type Arch } from "@ace/release/native-arch";
import { dist as builtDist } from "./common.ts";
import { koffiBinary, koffiLicense, mainProcessNeedsKoffi } from "./koffi.ts";

/**
 * Never ship a package whose native code cannot run: each required piece must be present and
 * runnable, and no staged binary may be built for another architecture. Checks the build in
 * `dist` for `platform` (this machine's build by default).
 */
export async function verifyNatives(
  arch: Arch,
  platform: NodeJS.Platform = process.platform,
  dist = builtDist,
): Promise<void> {
  const executable = (folder: string, name: string) =>
    join(dist, folder, platform === "win32" ? `${name}.exe` : name);
  // The daemon runs these directly, so a lost mode bit would show only on a user's machine.
  const executables = [
    executable("media", "ace-media"),
    executable("files", "ace-files"),
    join(dist, "bin", platform === "win32" ? "rg.exe" : "rg"),
  ];
  // Windows terminals need no guardian: a Job Object owns them (ADR 0095).
  const required = [
    ...executables,
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
  if (platform !== "win32")
    for (const path of executables)
      if (existsSync(path) && ((await stat(path)).mode & 0o111) === 0)
        problems.push(`${path} is not executable`);
  for (const found of await mismatchedBinaries(
    ["daemon", "node_modules", "bin", "helpers", "runtime", "spade", "media", "files"]
      .map((name) => join(dist, name))
      .filter((path) => existsSync(path)),
    platform,
    arch,
  ))
    problems.push(`${found.path} is ${found.arches.join("+")}, not ${arch}`);
  if (problems.length)
    throw new Error(`The ${arch} package would not run:\n  ${problems.join("\n  ")}`);
}
