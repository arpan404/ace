import { collectLicenses } from "./licenses.ts";
import { bundleDaemon } from "./bundle.ts";
import { create } from "tar";
import { mkdir, readFile, writeFile, cp, chmod, readdir, stat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createPublicKey } from "node:crypto";
import { z } from "zod";
import { ReleaseTarget, ReleaseVersion } from "@ace/protocol";
import { hashFile, downloadArchive } from "@ace/service";
import { extract } from "tar";
const nodeVersion = "24.13.0";
const hashes = {
  "darwin-arm64": "d595961e563fcae057d4a0fb992f175a54d97fcc4a14dc2d474d92ddeea3b9f8",
  "darwin-x64": "6f03c1b48ddbe1b129a6f8038be08e0899f05f17185b4d3e4350180ab669a7f3",
  "linux-arm64": "0f6d40b94c6a2eb6b4c240ffc8b9fd3ada7ab044c177dd413c06e1ef9a63f081",
  "linux-x64": "6223aad1a81f9d1e7b682c59d12e2de233f7b4c37475cd40d1c89c42b737ffa8",
};
const NativeInputs = z.record(
  ReleaseTarget,
  z
    .object({
      pty: z.string(),
      ptySha256: z.string().regex(/^[a-f0-9]{64}$/),
      helper: z.string(),
      helperSha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
);
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
  const nodeArchive = `node-v${nodeVersion}-${target}.tar.gz`;
  const archivePath = join(output, nodeArchive);
  // Known hashes are pinned from the official Node release SHASUMS256.txt.
  try {
    if ((await hashFile(archivePath)) !== hashes[target])
      throw new Error("Untrusted cached Node runtime");
  } catch {
    await rm(archivePath, { force: true });
    const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${nodeArchive}`, {
      signal: AbortSignal.timeout(120_000),
    });
    const bytes = Number(response.headers.get("content-length"));
    await downloadArchive(response, archivePath, {
      version,
      target,
      channel: "stable",
      archive: "ace-node.tar.gz",
      bytes,
      sha256: hashes[target],
    });
  }
  await extract({
    file: archivePath,
    cwd: root,
    strip: 1,
    filter: (path) => path.endsWith("/bin/node") || path.endsWith("/LICENSE"),
  });
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
  for (const name of ["pty.node", "spawn-helper"]) {
    const input = native
      ? name === "pty.node"
        ? native.pty
        : native.helper
      : join(prebuild, name);
    const checksum = native
      ? name === "pty.node"
        ? native.ptySha256
        : native.helperSha256
      : undefined;
    if (checksum && (await hashFile(input)) !== checksum)
      throw new Error("Native input checksum mismatch");
    await cp(input, join(destination, "prebuilds", target, name));
  }
  await chmod(join(destination, "prebuilds", target, "spawn-helper"), 0o755);
  const inputs = await bundleDaemon(repo, root, publicKey);
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
