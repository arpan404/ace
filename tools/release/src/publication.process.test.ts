import { execFile } from "node:child_process";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { hashFile } from "@ace/service";
import { createReleaseArchive } from "./archive.ts";

const execute = promisify(execFile);
const base = "https://github.com/arpan404/ace/releases/download/v1.2.0";
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

/** A dist directory holding signed release artifacts for `targets` only. */
async function dist(targets: string[], version = "1.2.0") {
  const directory = await mkdtemp(join(tmpdir(), "ace-publication-subset-"));
  directories.push(directory);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = join(directory, "public.pem");
  await writeFile(key, publicKey.export({ type: "spki", format: "pem" }));
  const hashes: Record<string, string> = {};
  for (const target of targets)
    hashes[target] = await signedTarget(directory, target, version, privateKey);
  return { directory, key, hashes };
}

async function signedTarget(directory: string, target: string, version: string, key: KeyObject) {
  const source = join(directory, `input-${target}`);
  await mkdir(join(source, "bin"), { recursive: true });
  await writeFile(join(source, "bin/node"), "runtime fixture", { mode: 0o755 });
  await writeFile(join(source, "ace.mjs"), "// daemon fixture\n");
  await writeFile(join(source, "ACE-LICENSE"), "Apache-2.0 fixture");
  await writeFile(
    join(source, "release.json"),
    JSON.stringify({ version, channel: "stable", target }),
  );
  const archive = `ace-${version}-${target}.tar.gz`;
  await createReleaseArchive(source, join(directory, archive));
  await rm(source, { recursive: true, force: true });
  const sha256 = await hashFile(join(directory, archive));
  const bytes = Buffer.from(
    JSON.stringify({
      version,
      channel: "stable",
      target,
      archive,
      bytes: (await readFile(join(directory, archive))).length,
      sha256,
    }),
  );
  await writeFile(join(directory, `${target}.json`), bytes);
  await writeFile(join(directory, `${target}.sig`), sign(null, bytes, key).toString("base64"));
  return sha256;
}

const publish = (directory: string, key: string) =>
  execute(process.execPath, [join(import.meta.dirname, "publication.ts"), directory, base, key]);

test(
  "a Linux-only release publishes an installer that pins Linux and refuses macOS by name",
  { timeout: 60_000 },
  async () => {
    const { directory, key, hashes } = await dist(["linux-x64", "linux-arm64"]);
    await publish(directory, key);
    const installer = await readFile(join(directory, "install.sh"), "utf8");
    expect(installer).toContain(`linux-x64) pinned='${hashes["linux-x64"]}'`);
    expect(installer).toContain(`linux-arm64) pinned='${hashes["linux-arm64"]}'`);
    expect(installer).toContain("darwin-arm64) pinned=''");
    expect(installer).not.toMatch(/__ACE_[A-Z0-9_]+_SHA256__/);
    // The formula names every target's archive, so a partial release has none.
    await expect(readFile(join(directory, "homebrew/ace.rb"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const npx: { target: string }[] = JSON.parse(
      await readFile(join(directory, "npx.json"), "utf8"),
    );
    expect(npx.map((entry) => entry.target).toSorted()).toEqual(["linux-arm64", "linux-x64"]);

    // The published installer on a host whose target is missing stops before any download.
    const fake = join(directory, "fake-bin");
    await mkdir(fake);
    await writeFile(
      join(fake, "uname"),
      '#!/bin/sh\n[ "$1" = -s ] && echo Darwin || echo arm64\n',
      {
        mode: 0o755,
      },
    );
    await writeFile(join(fake, "curl"), "#!/bin/sh\necho downloaded >&2\nexit 1\n", {
      mode: 0o755,
    });
    const refused = execute("sh", [join(directory, "install.sh")], {
      env: { ...process.env, PATH: `${fake}:/usr/bin:/bin` },
    });
    await expect(refused).rejects.toMatchObject({
      stderr: "This ace release has no darwin-arm64 build\n",
    });
  },
);

test("publication refuses a directory with no signed target", async () => {
  const { directory, key } = await dist([]);
  await expect(publish(directory, key)).rejects.toMatchObject({
    stderr: expect.stringContaining("No release target to publish"),
  });
  await expect(readFile(join(directory, "install.sh"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("publication refuses targets built for different versions", async () => {
  const { directory, key } = await dist(["linux-x64"]);
  const other = generateKeyPairSync("ed25519");
  // Re-sign everything with one key so only the version disagrees.
  await writeFile(key, other.publicKey.export({ type: "spki", format: "pem" }));
  const bytes = await readFile(join(directory, "linux-x64.json"));
  await writeFile(
    join(directory, "linux-x64.sig"),
    sign(null, bytes, other.privateKey).toString("base64"),
  );
  await signedTarget(directory, "linux-arm64", "1.3.0", other.privateKey);
  await expect(publish(directory, key)).rejects.toMatchObject({
    stderr: expect.stringContaining("Publication versions differ"),
  });
});

test(
  "a full macOS and Linux release writes the Homebrew formula and no Windows installer",
  { timeout: 60_000 },
  async () => {
    const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
    const { directory, key, hashes } = await dist(targets);
    await publish(directory, key);
    const formula = await readFile(join(directory, "homebrew/ace.rb"), "utf8");
    for (const target of targets) expect(formula).toContain(hashes[target]);
    expect(formula).not.toMatch(/@[A-Z0-9_]+_SHA256@/);
    await expect(readFile(join(directory, "install.ps1"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

test(
  "a release with a Windows build publishes install.ps1 pinning it, with its checksum",
  { timeout: 60_000 },
  async () => {
    const { directory, key, hashes } = await dist(["win32-x64"]);
    await publish(directory, key);
    const installer = await readFile(join(directory, "install.ps1"), "utf8");
    expect(installer).toContain(`$pinned = '${hashes["win32-x64"]}'`);
    expect(installer).toContain("$pinned = ''");
    expect(await readFile(join(directory, "install.ps1.sha256"), "utf8")).toBe(
      `${await hashFile(join(directory, "install.ps1"))}  install.ps1\n`,
    );
  },
);
