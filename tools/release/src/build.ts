import { collectLicenses } from "./licenses.ts";
import { bundleDaemon } from "./bundle.ts";
import { LinuxNativeInput, stageNativeFiles } from "./native-assets.ts";
import { create } from "tar";
import { mkdir, readFile, writeFile, cp, chmod, readdir, stat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createPublicKey } from "node:crypto";
import { z } from "zod";
import { ReleaseTarget, ReleaseVersion } from "@ace/protocol";
import { hashFile } from "@ace/service";
import { nodeVersion, stageNodeRuntime } from "./node-runtime.ts";
const NativeInputs = z.record(ReleaseTarget, LinuxNativeInput.optional());
async function files(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const name of (await readdir(join(root, prefix))).toSorted()) {
    const path = join(prefix, name);
    if ((await stat(join(root, path))).isDirectory()) result.push(...(await files(root, path)));
    else result.push(path);
  }
  return result;
}
async function main() {
  if (process.versions.node !== nodeVersion)
    throw new Error(`Release builds require Node ${nodeVersion}; use that runtime on PATH`);
  const version = ReleaseVersion.parse(process.argv[2]);
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
  await cp(join(installedPty, "lib"), join(destination, "lib"), { recursive: true });
  await cp(join(installedPty, "package.json"), join(destination, "package.json"));
  await cp(join(installedPty, "LICENSE"), join(destination, "LICENSE"));
  await stageNativeFiles(target, prebuild, join(destination, "prebuilds", target), native);
  const inputs = await bundleDaemon(repo, root, publicKey, target);
  await collectLicenses(inputs, root);
  await cp(join(repo, "LICENSE"), join(root, "ACE-LICENSE"));
  await writeFile(
    join(root, "release.json"),
    JSON.stringify({ version, target, channel: version.includes("-") ? "preview" : "stable" }) +
      "\n",
  );
  const paths = await files(root);
  const checksums: Record<string, string> = {};
  for (const path of paths) {
    await chmod(
      join(root, path),
      path === "bin/node" || path.endsWith("spawn-helper") ? 0o755 : 0o644,
    );
    checksums[path] = await hashFile(join(root, path));
  }
  await writeFile(
    join(root, "files.json"),
    JSON.stringify({ nodeVersion, version, target, checksums }) + "\n",
  );
  const archive = `ace-${version}-${target}.tar.gz`;
  await create(
    {
      cwd: root,
      file: join(output, archive),
      gzip: true,
      portable: true,
      mtime: new Date(0),
      noDirRecurse: true,
    },
    [...paths, "files.json"].toSorted(),
  );
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
await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
