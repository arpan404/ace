import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { list } from "tar";
import { expect, test } from "vitest";
import { createReleaseArchive } from "./archive.ts";
import { stageSpadeServer, type Cargo } from "./spade-server.ts";

async function release(onTestFinished: (fn: () => Promise<void>) => void) {
  const dir = await mkdtemp(join(tmpdir(), "ace-spade-package-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "root");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "bin/node"), "runtime", { mode: 0o755 });
  await writeFile(join(root, "release.json"), "{}\n");
  const prebuilt = join(dir, "spade-server-prebuilt");
  await writeFile(prebuilt, "spade", { mode: 0o755 });
  const archived = async () => {
    const file = join(dir, "ace.tar.gz");
    await createReleaseArchive(root, file);
    const entries: string[] = [];
    await list({ file, onReadEntry: (entry) => entries.push(entry.path) });
    return entries.toSorted();
  };
  return { dir, root, prebuilt, archived };
}

const noCargo: Cargo = () => {
  throw new Error("cargo: command not found");
};

test("a release archive carries the prebuilt spade-server it was given", async ({
  onTestFinished,
}) => {
  const { dir, root, prebuilt, archived } = await release(onTestFinished);
  const how = await stageSpadeServer({
    repo: dir,
    root,
    target: "linux-x64",
    env: { ACE_SPADE_SERVER_BIN: prebuilt },
    cargo: noCargo,
  });
  expect(how).toBe("prebuilt");
  expect(await archived()).toEqual(["bin/node", "release.json", "spade/spade-server"]);
});

test("a Windows release carries spade-server.exe", async ({ onTestFinished }) => {
  const { dir, root, prebuilt, archived } = await release(onTestFinished);
  await stageSpadeServer({
    repo: dir,
    root,
    target: "win32-x64",
    env: { ACE_SPADE_SERVER_BIN: prebuilt },
  });
  expect(await archived()).toContain("spade/spade-server.exe");
});

test("without a prebuilt binary cargo builds it in release mode for the target", async ({
  onTestFinished,
}) => {
  const { dir, root, archived } = await release(onTestFinished);
  const built = join(dir, "spade/target/aarch64-apple-darwin/release");
  const cargo: Cargo = (args, cwd) => {
    expect(cwd).toBe(join(dir, "spade"));
    expect(args).toEqual(
      expect.arrayContaining(["build", "--release", "-p", "spade-server", "aarch64-apple-darwin"]),
    );
  };
  await mkdir(built, { recursive: true });
  await writeFile(join(built, "spade-server"), "built", { mode: 0o755 });
  expect(await stageSpadeServer({ repo: dir, root, target: "darwin-arm64", env: {}, cargo })).toBe(
    "built",
  );
  expect(await archived()).toContain("spade/spade-server");
});

test("a release that can't build Spade fails loudly", async ({ onTestFinished }) => {
  const { dir, root } = await release(onTestFinished);
  await expect(
    stageSpadeServer({ repo: dir, root, target: "linux-arm64", env: {}, cargo: noCargo }),
  ).rejects.toThrow(/DISABLE_SPADE=1/);
  await expect(
    stageSpadeServer({
      repo: dir,
      root,
      target: "linux-arm64",
      env: { ACE_SPADE_SERVER_BIN: join(dir, "missing") },
    }),
  ).rejects.toThrow(/missing/);
});

test("DISABLE_SPADE=1 leaves spade-server out of the archive", async ({ onTestFinished }) => {
  const { dir, root, prebuilt, archived } = await release(onTestFinished);
  const how = await stageSpadeServer({
    repo: dir,
    root,
    target: "linux-x64",
    env: { DISABLE_SPADE: "1", ACE_SPADE_SERVER_BIN: prebuilt },
    cargo: noCargo,
  });
  expect(how).toBe("disabled");
  expect(await archived()).toEqual(["bin/node", "release.json"]);
});
