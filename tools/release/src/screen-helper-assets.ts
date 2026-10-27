import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The Linux screen helper's file name, wherever it is staged. */
export const linuxScreenHelperName = "ace-screen-helper-linux";

/**
 * Where a daemon release keeps the Linux screen helper, relative to the directory holding the
 * daemon entry bundle (`ace.mjs`): the daemon looks for it there when no path is configured.
 */
export const linuxScreenHelperPath = join("helpers", linuxScreenHelperName);

const triples = { arm64: "aarch64-unknown-linux-gnu", x64: "x86_64-unknown-linux-gnu" } as const;

/**
 * Builds `native/screen-helper-linux` for this host (release builds run in the Debian 12
 * container, so it needs glibc 2.36) and copies the executable to `destination`.
 */
export async function stageLinuxScreenHelper(repo: string, destination: string): Promise<void> {
  if (process.platform !== "linux" || (process.arch !== "arm64" && process.arch !== "x64"))
    throw new Error("Build the Linux screen helper on a Linux arm64 or x64 host");
  const crate = join(repo, "native/screen-helper-linux");
  execFileSync("sh", [join(crate, "build.sh")], { stdio: "inherit" });
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(
    join(crate, "build", `${linuxScreenHelperName}-${triples[process.arch]}`),
    destination,
  );
  await chmod(destination, 0o755);
}
