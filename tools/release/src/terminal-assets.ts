import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ReleaseTarget } from "@ace/protocol";

/** Where `@ace/terminal` looks for its guardian in the source tree, and in a bundle. */
export const guardianSourcePath = '"../native/group-keeper"';
export const guardianBundlePath = '"./group-keeper"';

const macArch = { "darwin-arm64": "arm64", "darwin-x64": "x86_64" } as const;

/**
 * Builds the terminal guardian (`packages/terminal/native/group-keeper.c`) into the bundle
 * root as `group-keeper`, beside `ace.mjs`. Every terminal the daemon opens starts it, so a
 * bundle without it cannot open a shell. It is a dependency-free POSIX program, compiled
 * for the target: macOS hosts build either architecture with `-arch`; other targets build
 * on a matching host, like node-pty.
 */
export function stageTerminalGuardian(repo: string, root: string, target: string): void {
  const platform = ReleaseTarget.parse(target);
  const source = join(repo, "packages/terminal/native/group-keeper.c");
  const flags = ["-std=c11", "-O2", "-Wall", "-Wextra"];
  if (process.platform === "darwin" && (platform === "darwin-arm64" || platform === "darwin-x64"))
    flags.push("-arch", macArch[platform]);
  else if (platform !== `${process.platform}-${process.arch}`)
    throw new Error(`Build the ${platform} terminal guardian on a ${platform} host`);
  execFileSync("cc", [...flags, source, "-o", join(root, "group-keeper")], { stdio: "inherit" });
}
