import { execFileSync, spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { hashFile } from "@ace/service";
import type { ReleaseTarget } from "@ace/protocol";
import type { z } from "zod";
import { checkLinuxMedia, mediaSizeLimit, stagedAceMedia } from "./ace-media.ts";

type Target = z.infer<typeof ReleaseTarget>;
const run = (command: string, args: string[]) =>
  execFileSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });

// codesign writes signature metadata to stderr.
const display = (args: string[]) => {
  const result = spawnSync("codesign", args, { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout + result.stderr;
};

/** Run the stub using the shipped daemon runtime, from the shipped layout, with no source imports. */
export async function smokeMedia(root: string, target: Target, version: string, runtime: string) {
  const binary = stagedAceMedia(root, target);
  if ((await stat(binary)).size > mediaSizeLimit) throw new Error("ace-media exceeds 8 MB");
  const output = run(runtime, [
    "-e",
    `const {execFileSync}=require('node:child_process');const p=${JSON.stringify(binary)};if(execFileSync(p,['--version'],{encoding:'utf8',timeout:10000}).trim()!==${JSON.stringify(version)})throw Error('ace-media version mismatch');execFileSync(p,[],{timeout:10000,stdio:'pipe'});`,
  ]);
  if (output.trim()) throw new Error("Unexpected media smoke output");
  if (target.startsWith("linux-")) await checkLinuxMedia(binary);
  process.stdout.write(
    `ace-media ${target}: packaged version and clean exit passed (${await hashFile(binary)})\n`,
  );
}

export async function verifyMediaDesktop(
  app: string,
  target: Target,
  identityFile: string,
  local: boolean,
) {
  if (target.startsWith("darwin-")) {
    run("codesign", ["--verify", "--deep", "--strict", app]);
    const binary = stagedAceMedia(join(app, "Contents/Resources"), target);
    run("codesign", ["--verify", "--strict", binary]);
    const metadata = display(["-dvv", binary]);
    if (!metadata.includes("runtime")) throw new Error("ace-media lacks hardened runtime");
    if (!local && !metadata.includes("Authority=Developer ID Application:"))
      throw new Error("ace-media lacks Developer ID");
    if (display(["-d", "--entitlements", ":-", binary]).includes("<key>"))
      throw new Error("ace-media must have no entitlements");
    const requirement = display(["-d", "-r-", join(app, "Contents/Helpers/AceScreenHelper.app")])
      .split("\n")
      .find((line) => line.startsWith("designated => "));
    if (requirement !== (await readFile(identityFile, "utf8")).trim())
      throw new Error("Screen helper identity changed: Screen Recording grants would be lost");
    if (!local) {
      run("spctl", ["--assess", "--type", "execute", app]);
      run("xcrun", ["stapler", "validate", app]);
    }
  } else if (target.startsWith("win32-") && !local) {
    run("signtool", ["verify", "/pa", stagedAceMedia(join(app, "resources"), target)]);
  }
}
