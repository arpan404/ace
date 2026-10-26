import { execFileSync } from "node:child_process";
import { collectLicenses } from "./licenses.ts";
import { bundleDaemon } from "./bundle.ts";
import { LinuxNativeInput, stageNativeFiles } from "./native-assets.ts";
import { releaseFiles, createReleaseArchive } from "./archive.ts";
import { copyRuntimePackage } from "./copy-runtime-package.ts";
import { mkdir, readFile, writeFile, cp, chmod, stat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createPublicKey } from "node:crypto";
import { z } from "zod";
import { ReleaseTarget, ReleaseVersion } from "@ace/protocol";
import { hashFile, releaseArchiveLimits } from "@ace/service";
import { nodeVersion, stageNodeRuntime } from "./node-runtime.ts";
import { mismatchedBinaries } from "./native-arch.ts";
import { assertLinuxRuntimeFloor } from "./glibc.ts";
import { linuxScreenHelperPath, stageLinuxScreenHelper } from "./screen-helper-assets.ts";
const NativeInputs = z.record(ReleaseTarget, LinuxNativeInput.optional());
async function main() {
  const version = ReleaseVersion.parse(process.argv[2]);
  if (process.versions.node !== nodeVersion)
    throw new Error(`Release builds require Node ${nodeVersion}; use that runtime on PATH`);
  const target = ReleaseTarget.parse(process.argv[3]);
  const publicKeyPath = process.argv[4];
  if (!publicKeyPath)
    throw new Error("Usage: build VERSION TARGET PUBLIC_KEY.pem [native-inputs.json]");
  const key = createPublicKey(await readFile(publicKeyPath));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 public key required");
  const publicKey = key.export({ type: "spki", format: "pem" }).toString();
  const repo = resolve(import.meta.dirname, "../../..");
  const output = join(repo, "tools/release/dist");
  const root = join(output, target);
  await mkdir(output, { recursive: true });
  await rm(join(output, `${target}.json`), { force: true });
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, "bin"), { recursive: true });
  await stageNodeRuntime({ target, version, cacheDir: output, destination: root });
  const native = process.argv[5]
    ? NativeInputs.parse(JSON.parse(await readFile(process.argv[5], "utf8")))[target]
    : undefined;
  const installedPty = join(repo, "tools/release/node_modules/node-pty");
  const prebuild = join(installedPty, "prebuilds", target);
  const destination = join(root, "node_modules/node-pty");
  await mkdir(join(destination, "prebuilds", target), { recursive: true });
  await copyRuntimePackage(join(installedPty, "lib"), join(destination, "lib"));
  await cp(join(installedPty, "package.json"), join(destination, "package.json"));
  await cp(join(installedPty, "LICENSE"), join(destination, "LICENSE"));
  await stageNativeFiles(target, prebuild, join(destination, "prebuilds", target), native);
  execFileSync("bun", ["x", "vite", "build"], { cwd: join(repo, "apps/web"), stdio: "inherit" });
  // The web build emits hidden source maps; nothing loads them, so they stay out of the archive.
  await cp(join(repo, "apps/web/dist"), join(root, "web"), {
    recursive: true,
    filter: (path) => !path.endsWith(".map"),
  });
  const inputs = await bundleDaemon(repo, root, publicKey, target);
  await collectLicenses(inputs, root);
  await cp(join(repo, "LICENSE"), join(root, "ACE-LICENSE"));
  if (target === "linux-x64" || target === "linux-arm64") {
    if (target !== `${process.platform}-${process.arch}`)
      throw new Error(`Build the ${target} release on a ${target} host`);
    await stageLinuxScreenHelper(repo, join(root, linuxScreenHelperPath));
  }
  await assertTargetNatives(root, target);
  await writeFile(
    join(root, "release.json"),
    JSON.stringify({ version, target, channel: version.includes("-") ? "preview" : "stable" }) +
      "\n",
  );
  const paths = await releaseFiles(root);
  // files.json and release.json are added too; the updater's budget counts every entry.
  process.stdout.write(
    `[release] ${paths.length + 1} of ${releaseArchiveLimits.entries} archive entries used\n`,
  );
  const checksums: Record<string, string> = {};
  for (const path of paths) {
    await chmod(
      join(root, path),
      path === "bin/node" ||
        path.endsWith("spawn-helper") ||
        ((await stat(join(root, path))).mode & 0o111) !== 0
        ? 0o755
        : 0o644,
    );
    checksums[path] = await hashFile(join(root, path));
  }
  await writeFile(
    join(root, "files.json"),
    JSON.stringify({ nodeVersion, version, target, checksums }) + "\n",
  );
  const archive = `ace-${version}-${target}.tar.gz`;
  await createReleaseArchive(root, join(output, archive));
  const manifest = {
    version,
    channel: version.includes("-") ? "preview" : "stable",
    target,
    archive,
    bytes: (await stat(join(output, archive))).size,
    sha256: await hashFile(join(output, archive)),
  };
  await writeFile(join(output, `${target}.json`), JSON.stringify(manifest) + "\n");
  process.stdout.write(JSON.stringify(manifest) + "\n");
}
/**
 * Every native file in the release must run on the target: the right architecture (a host
 * `descriptor.node` or guardian copied into another target fails only on the user's machine)
 * and, on Linux, nothing newer than the glibc 2.31 floor.
 */
async function assertTargetNatives(root: string, target: string) {
  const [platform, arch] = target.split("-");
  if (platform === "win32" && (arch === "arm64" || arch === "x64"))
    return assertWindowsNatives(root, target, arch);
  if ((platform !== "linux" && platform !== "darwin") || (arch !== "arm64" && arch !== "x64"))
    throw new Error(`Unsupported release target ${target}`);
  const mismatched = await mismatchedBinaries([root], platform, arch);
  if (mismatched.length)
    throw new Error(
      `Native files built for another architecture than ${target}:\n  ` +
        mismatched.map((found) => `${found.path} (${found.arches.join("+")})`).join("\n  "),
    );
  if (platform === "linux")
    for (const known of await assertLinuxRuntimeFloor([root]))
      console.warn(`Above the glibc floor (reviewed): ${known.path}: ${known.reason}`);
}
/** Windows releases are built on a native runner of the target architecture. */
async function assertWindowsNatives(root: string, target: string, arch: "arm64" | "x64") {
  if (target !== `${process.platform}-${process.arch}`)
    throw new Error(`Build the ${target} release on a ${target} host`);
  const mismatched = await mismatchedBinaries([root], "win32", arch);
  if (mismatched.length)
    throw new Error(
      `Native files built for another architecture than ${target}:\n  ` +
        mismatched.map((found) => `${found.path} (${found.arches.join("+")})`).join("\n  "),
    );
}
await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
