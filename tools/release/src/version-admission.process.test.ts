import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { installedVersion } from "@ace/service";
import { installArtifact } from "./runtime.ts";

afterEach(() => vi.unstubAllEnvs());

test("a legacy build refuses before output changes or public-key reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-release-build-version-"));
  try {
    const release = join(directory, "tools/release");
    await cp(import.meta.dirname, join(release, "src"), { recursive: true });
    await symlink(resolve(import.meta.dirname, "../node_modules"), join(release, "node_modules"));
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    await mkdir(join(release, "dist"));
    await writeFile(join(release, "dist/keep"), "prior output");
    await expect(
      promisify(execFile)(process.execPath, [
        join(release, "src/build.ts"),
        "0.1.0",
        `${process.platform}-${process.arch}`,
        join(directory, "missing-key"),
      ]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("Legacy ace 0.x") });
    expect(await readdir(join(release, "dist"))).toEqual(["keep"]);
    expect(await readFile(join(release, "dist/keep"), "utf8")).toBe("prior output");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a refused legacy artifact leaves an empty home usable for a compatible install", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-release-version-"));
  try {
    const home = join(directory, "home"),
      artifact = join(directory, "artifact");
    await mkdir(home);
    await mkdir(artifact);
    vi.stubEnv("ACE_HOME", home);
    const manifest = {
      version: "0.1.0",
      target: `${process.platform}-${process.arch}`,
      channel: "stable",
    };
    await writeFile(join(artifact, "release.json"), JSON.stringify(manifest));
    await expect(installArtifact(artifact)).rejects.toThrow();
    expect(await readdir(home)).toEqual([]);
    await writeFile(
      join(artifact, "release.json"),
      JSON.stringify({ ...manifest, version: "1.0.0" }),
    );
    await writeFile(join(artifact, "ace.mjs"), "compatible artifact");
    const installed = join(directory, "service-installed");
    await installArtifact(artifact, async (root) => {
      await writeFile(installed, root);
    });
    expect(await readFile(installed, "utf8")).toBe(home);
    expect(installedVersion(home)).toBe("1.0.0");
    expect(await readFile(join(home, "current/ace.mjs"), "utf8")).toBe("compatible artifact");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
