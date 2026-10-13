import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { expect, test } from "vitest";
import { createReleaseArchive, createNpxPackage } from "@ace/release";
import { hashFile } from "@ace/service";
import { ReleaseTarget, type ReleaseManifest } from "@ace/protocol";

test(
  "npx runs the packaged CLI with stdin, literal arguments and the CLI exit code without installation",
  { timeout: 60000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ace-npx-test-"));
    try {
      const source = join(directory, "input");
      await mkdir(join(source, "bin"), { recursive: true });
      await writeFile(
        join(source, "bin/node"),
        `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`,
        { mode: 0o755 },
      );
      await writeFile(
        join(source, "ace.mjs"),
        `let input = ''; for await (const bytes of process.stdin) input += bytes; process.stdout.write(JSON.stringify({args:process.argv.slice(2), input})+'\\n'); process.exitCode=5;`,
      );
      const target = ReleaseTarget.parse(`${process.platform}-${process.arch}`);
      await writeFile(
        join(source, "release.json"),
        JSON.stringify({ version: "1.1.0", channel: "stable", target }),
      );
      await writeFile(join(source, "ACE-LICENSE"), "Apache-2.0 fixture");
      const archive = `ace-1.1.0-${target}.tar.gz`;
      await createReleaseArchive(source, join(directory, archive));
      const manifest: ReleaseManifest = {
        version: "1.1.0",
        channel: "stable",
        target,
        archive,
        sha256: await hashFile(join(directory, archive)),
        bytes: (await readFile(join(directory, archive))).length,
      };
      const artifact = await createNpxPackage(directory, manifest);
      const child = spawn(
        "npx",
        [
          "--yes",
          "--offline",
          "--cache",
          join(directory, "npm-cache"),
          // npm 11 runs a bare file argument as a command; name the package and its bin.
          "--package",
          join(directory, artifact.file),
          "ace",
          "run",
          "literal $(untouched) ; prompt",
          "--json",
        ],
        {
          env: { ...process.env, ACE_HOME: join(directory, "home") },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (bytes: Buffer) => {
        stdout += bytes.toString();
      });
      child.stderr.on("data", (bytes: Buffer) => {
        stderr += bytes.toString();
      });
      child.stdin.end("piped input");
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(code, stderr).toBe(5);
      expect(JSON.parse(stdout)).toEqual({
        args: ["run", "literal $(untouched) ; prompt", "--json"],
        input: "piped input",
      });
      await expect(readFile(join(directory, "home/current"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(join(directory, `${artifact.file}.sha256`), "utf8")).toContain(
        artifact.sha256,
      );
      await writeFile(join(directory, archive), "changed");
      await expect(createNpxPackage(directory, manifest)).rejects.toThrow("artifact mismatch");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
