import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { daemonToolchains } from "./toolchains.ts";

async function pathWithServeSim(version?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ace-serve-sim-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  if (version !== undefined) {
    const path = join(root, "serve-sim");
    await writeFile(path, `#!/bin/sh\necho '${version}'\n`);
    await chmod(path, 0o700);
  }
  return root;
}

it("a Mac lists serve-sim after Xcode with its version, ready only at a version ace runs", async () => {
  const supported = await daemonToolchains({ PATH: await pathWithServeSim("0.1.48") }, "darwin");
  expect(supported.map((tool) => tool.id)).toEqual(["git", "xcode", "serve-sim", "android"]);
  expect(supported[2]).toMatchObject({
    available: true,
    version: "0.1.48",
    detail: "serve-sim 0.1.48",
  });

  const old = await daemonToolchains({ PATH: await pathWithServeSim("0.0.9") }, "darwin");
  expect(old.find((tool) => tool.id === "serve-sim")).toMatchObject({
    available: false,
    version: "0.0.9",
    hint: expect.stringContaining("npm install -g serve-sim@"),
  });

  const missing = await daemonToolchains({ PATH: await pathWithServeSim() }, "darwin");
  expect(missing.find((tool) => tool.id === "serve-sim")).toMatchObject({
    available: false,
    detail: "serve-sim not found",
  });
});

it("other platforms have no serve-sim entry", async () => {
  const tools = await daemonToolchains({ PATH: await pathWithServeSim("0.1.48") }, "linux");
  expect(tools.map((tool) => tool.id)).toEqual(["git", "android"]);
});
