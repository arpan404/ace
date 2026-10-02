import { expect, test } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { create } from "tar";
import { hashFile } from "@ace/service";
const exec = promisify(execFile);
test(
  "the POSIX installer verifies signatures and checksums before invoking artifact code",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-install-"));
    try {
      const source = join(root, "input"),
        bin = join(root, "fake-bin"),
        fixture = join(root, "feed");
      await mkdir(join(source, "bin"), { recursive: true });
      await mkdir(bin);
      await mkdir(fixture);
      const marker = join(root, "executed");
      await writeFile(
        join(source, "bin/node"),
        `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`,
        { mode: 0o755 },
      );
      await writeFile(
        join(source, "ace.mjs"),
        'import {writeFileSync} from "node:fs"; writeFileSync(process.env.TEST_MARKER,"verified");',
      );
      const os = (await exec("uname", ["-s"])).stdout.trim() === "Darwin" ? "darwin" : "linux";
      const arch = (await exec("uname", ["-m"])).stdout.trim();
      const target = `${os}-${arch === "x86_64" ? "x64" : "arm64"}`;
      const archive = "ace-1.0.0-test.tar.gz";
      await create({ cwd: source, file: join(fixture, archive), gzip: true }, [
        "bin/node",
        "ace.mjs",
      ]);
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const key = publicKey.export({ type: "spki", format: "pem" }).toString();
      const manifest = Buffer.from(
        JSON.stringify({
          version: "1.0.0",
          channel: "stable",
          target,
          archive,
          bytes: (await readFile(join(fixture, archive))).length,
          sha256: await hashFile(join(fixture, archive)),
        }),
      );
      await writeFile(join(fixture, `${target}.json`), manifest);
      await writeFile(
        join(fixture, `${target}.sig`),
        sign(null, manifest, privateKey).toString("base64") + "\n",
      );
      await writeFile(
        join(bin, "curl"),
        `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const a=process.argv.slice(2);fs.copyFileSync(path.join(${JSON.stringify(fixture)},path.basename(new URL(a[a.length-3]).pathname)),a[a.length-1]);\n`,
        { mode: 0o755 },
      );
      const digest = await hashFile(join(fixture, archive));
      const originalArchive = await readFile(join(fixture, archive));
      const script = (await readFile(new URL("../install.sh", import.meta.url), "utf8"))
        .replace("__ACE_RELEASE_PUBLIC_KEY__", key.trim())
        .replace("__ACE_RELEASE_BASE_URL__", "https://release.test/v1")
        .replace(`__ACE_${target.replace("-", "_").toUpperCase()}_SHA256__`, digest);
      const installer = join(root, "install.sh");
      await writeFile(installer, script);
      const env = {
        ...process.env,
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        TEST_MARKER: marker,
      };
      await exec("sh", [installer], { env, timeout: 60_000 });
      expect(await readFile(marker, "utf8")).toBe("verified");
      await rm(marker);
      await writeFile(join(fixture, archive), "tampered archive");
      await expect(exec("sh", [installer], { env, timeout: 60_000 })).rejects.toThrow();
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(join(fixture, archive), originalArchive);
      await writeFile(join(fixture, `${target}.sig`), Buffer.alloc(64).toString("base64") + "\n");
      await expect(exec("sh", [installer], { env, timeout: 60_000 })).rejects.toThrow();
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
