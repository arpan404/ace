import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { expect, test } from "vitest";
import { bundleDaemon, createReleaseArchive } from "@ace/release";
import { unpackArchive, applyUpdate, atomicPointer, hashFile } from "@ace/service";
import { ReleaseTarget } from "@ace/protocol";
import { collectLicenses } from "./licenses.ts";
import { create } from "tar";

const execute = promisify(execFile);

test(
  "a bundled release can cross the installed updater's archive boundary",
  { timeout: 120_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "ace-release-budget-"));
    try {
      const root = join(temporary, "artifact");
      await mkdir(root);
      const inputs = await bundleDaemon(resolve(import.meta.dirname, "../../.."), root, "");
      await collectLicenses(inputs, root);
      await mkdir(join(root, "bin"));
      await writeFile(join(root, "bin/node"), "owned runtime fixture");
      await writeFile(
        join(root, "release.json"),
        JSON.stringify({
          version: "1.1.0",
          channel: "stable",
          target: `${process.platform}-${process.arch}`,
        }),
      );
      const archive = join(temporary, "ace-1.1.0-test.tar.gz");
      await createReleaseArchive(root, archive);
      const installed = join(temporary, "unpacked");
      await unpackArchive(archive, installed);
      expect(await readFile(join(installed, "bin/node"), "utf8")).toBe("owned runtime fixture");
      expect(await readFile(join(installed, "release.json"), "utf8")).toContain("1.1.0");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

test("the producer refuses an archive over the oldest updater budget before it is advertised", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-release-oversized-"));
  try {
    const source = join(root, "input");
    await mkdir(source);
    for (let index = 0; index < 2049; index++)
      await writeFile(join(source, `entry-${index}`), "inert");
    const archive = join(root, "candidate.tar.gz");
    await expect(createReleaseArchive(source, archive)).rejects.toThrow("updater entry budget");
    await expect(readFile(archive)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publication refuses a signed oversized archive before emitting installer metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-publication-budget-"));
  try {
    const source = join(directory, "input");
    await mkdir(source);
    const paths = Array.from({ length: 2049 }, (_, index) => `entry-${index}`);
    for (const path of paths) await writeFile(join(source, path), "inert");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const key = join(directory, "public.pem");
    await writeFile(key, publicKey.export({ type: "spki", format: "pem" }));
    for (const target of ReleaseTarget.options) {
      const archive = `ace-1.1.0-${target}.tar.gz`;
      const file = join(directory, archive);
      await create({ cwd: source, file, gzip: true, portable: true, noDirRecurse: true }, paths);
      const payload = await readFile(file);
      const bytes = Buffer.from(
        JSON.stringify({
          version: "1.1.0",
          channel: "stable",
          target,
          archive,
          bytes: payload.length,
          sha256: await hashFile(file),
        }),
      );
      await writeFile(join(directory, `${target}.json`), bytes);
      await writeFile(
        join(directory, `${target}.sig`),
        sign(null, bytes, privateKey).toString("base64"),
      );
    }
    await expect(
      execute(process.execPath, [
        join(import.meta.dirname, "publication.ts"),
        directory,
        "https://github.com/arpan404/ace/releases/download/v1.1.0",
        key,
      ]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("Unsafe release archive") });
    for (const path of ["install.sh", "install.sh.sha256", "homebrew/ace.rb"])
      await expect(readFile(join(directory, path))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(ReleaseTarget.options)(
  "a produced %s candidate upgrades a compatible installed release through the bounded archive",
  async (target) => {
    const temporary = await mkdtemp(join(tmpdir(), "ace-release-upgrade-"));
    try {
      const root = join(temporary, "installed"),
        source = join(temporary, "source");
      const old = `releases/1.0.0-${target}`;
      await mkdir(join(root, old), { recursive: true });
      await writeFile(
        join(root, old, "release.json"),
        JSON.stringify({ version: "1.0.0", target, channel: "stable" }),
      );
      await writeFile(join(root, old, "marker"), "old daemon");
      await atomicPointer(join(root, "current"), old);
      await mkdir(source);
      await writeFile(join(source, "marker"), "candidate daemon");
      const archive = join(temporary, "candidate.tar.gz");
      await createReleaseArchive(source, archive);
      const payload = await readFile(archive);
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const bytes = Buffer.from(
        JSON.stringify({
          version: "1.1.0",
          target,
          channel: "stable",
          archive: `ace-1.1.0-${target}.tar.gz`,
          bytes: payload.length,
          sha256: await hashFile(archive),
        }),
      );
      let running = true;
      expect(
        await applyUpdate({
          root,
          dataDir: root,
          bytes,
          signature: sign(null, bytes, privateKey).toString("base64"),
          publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
          archiveUrl: "https://release.test/candidate",
          fetcher: async () => new Response(payload),
          drain: false,
          ports: {
            now: () => 0,
            wait: async () => {},
            maintenance: async () => ({ draining: true, blockers: 0 }),
            stop: async () => {
              running = false;
            },
            start: async () => {
              running = true;
            },
            health: async () => running,
            migrate: async () => {},
          },
        }),
      ).toBe("updated");
      expect(running).toBe(true);
      expect(await readFile(join(root, "current/marker"), "utf8")).toBe("candidate daemon");
      expect(await readFile(join(root, "previous/marker"), "utf8")).toBe("old daemon");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
