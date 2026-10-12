import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";
import { hashFile, installableVersion, unpackArchive } from "@ace/service";
import { InstalledRelease, ReleaseTarget, ReleaseManifest } from "@ace/protocol";
import { releaseFiles } from "./archive.ts";

/** npm wrapping keeps the exact verified runtime and adds no install scripts. */
export async function createNpxPackage(directory: string, input: ReleaseManifest) {
  const manifest = ReleaseManifest.parse(input);
  const target = ReleaseTarget.parse(manifest.target);
  const version = installableVersion(manifest.version);
  const archive = join(directory, manifest.archive);
  if ((await hashFile(archive)) !== manifest.sha256) throw new Error("npm artifact mismatch");
  const scratch = await mkdtemp(join(tmpdir(), "ace-npx-publication-"));
  const file = `ace-cli-${version}-${target}.tgz`;
  try {
    const root = join(scratch, "package");
    await mkdir(root);
    await unpackArchive(archive, join(root, "runtime"));
    const release = InstalledRelease.parse(
      JSON.parse(await readFile(join(root, "runtime/release.json"), "utf8")),
    );
    if (
      release.version !== version ||
      release.target !== target ||
      release.channel !== manifest.channel
    )
      throw new Error("npm runtime metadata mismatch");
    const [os, cpu] = target.split("-");
    await mkdir(join(root, "bin"));
    await cp(new URL("../npx/ace.mjs", import.meta.url), join(root, "bin/ace.mjs"));
    await cp(join(root, "runtime/ACE-LICENSE"), join(root, "LICENSE"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: `ace-cli-${target}`,
        version,
        type: "module",
        license: "Apache-2.0",
        bin: { ace: "bin/ace.mjs" },
        os: [os],
        cpu: [cpu],
        engines: { node: ">=20" },
        description: "ace CLI with its pinned daemon runtime",
        repository: { type: "git", url: "https://github.com/arpan404/ace.git" },
      }) + "\n",
    );
    const paths = await releaseFiles(root);
    await create(
      {
        cwd: scratch,
        file: join(directory, file),
        gzip: true,
        portable: true,
        mtime: new Date(0),
        noDirRecurse: true,
      },
      paths.map((path) => `package/${path}`),
    );
    const digest = await hashFile(join(directory, file));
    await writeFile(join(directory, `${file}.sha256`), `${digest}  ${file}\n`);
    return { target, file, sha256: digest };
  } catch (error) {
    await rm(join(directory, file), { force: true });
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
