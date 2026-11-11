import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { list } from "tar";
import { expect, test } from "vitest";
import { createReleaseArchive } from "./archive.ts";
import { stageSpadeServer, type Cargo } from "./spade-server.ts";

/** A stand-in `spade-server` whose `--version` prints `version`, as the stamped one does. */
const spadeScript = (version: string) => `#!/bin/sh\n[ "$1" = --version ] && echo ${version}\n`;

async function release(onTestFinished: (fn: () => Promise<void>) => void) {
  const dir = await mkdtemp(join(tmpdir(), "ace-spade-package-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "root");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "bin/node"), "runtime", { mode: 0o755 });
  await writeFile(join(root, "release.json"), "{}\n");
  const prebuilt = async (version: string) => {
    const path = join(dir, `spade-server-${version}`);
    await writeFile(path, spadeScript(version), { mode: 0o755 });
    return path;
  };
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

/** Builds like cargo would: the binary reports whatever ACE_SPADE_VERSION the build had. */
function fakeCargo(dir: string, triple: string): Cargo {
  return (args, cwd, env) => {
    expect(cwd).toBe(join(dir, "spade"));
    expect(args).toEqual(
      expect.arrayContaining(["build", "--locked", "--release", "-p", "spade-server", triple]),
    );
    const out = join(dir, "spade/target", triple, "release");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "spade-server"), spadeScript(env.ACE_SPADE_VERSION ?? "0.1.0"), {
      mode: 0o755,
    });
  };
}

const posix = process.platform !== "win32";

test.runIf(posix)(
  "a release archive carries the prebuilt spade-server it was given",
  async ({ onTestFinished }) => {
    const { dir, root, prebuilt, archived } = await release(onTestFinished);
    const how = await stageSpadeServer({
      repo: dir,
      root,
      target: "linux-x64",
      version: "0.5.0",
      env: { ACE_SPADE_SERVER_BIN: await prebuilt("0.5.0") },
      cargo: noCargo,
    });
    expect(how).toBe("prebuilt");
    expect(await archived()).toEqual(["bin/node", "release.json", "spade/spade-server"]);
  },
);

test.runIf(posix)(
  "a prebuilt spade-server reporting another version is refused",
  async ({ onTestFinished }) => {
    const { dir, root, prebuilt, archived } = await release(onTestFinished);
    await expect(
      stageSpadeServer({
        repo: dir,
        root,
        target: "linux-x64",
        version: "0.5.0",
        // Spade's own Cargo version: what an unstamped build reports.
        env: { ACE_SPADE_SERVER_BIN: await prebuilt("0.1.0") },
      }),
    ).rejects.toThrow(/reports version "0.1.0", not this release's 0.5.0/);
    expect(await archived()).toEqual(["bin/node", "release.json"]);
  },
);

test.runIf(posix)("a Windows release carries spade-server.exe", async ({ onTestFinished }) => {
  const { dir, root, prebuilt, archived } = await release(onTestFinished);
  await stageSpadeServer({
    repo: dir,
    root,
    target: "win32-x64",
    version: "0.5.0",
    env: { ACE_SPADE_SERVER_BIN: await prebuilt("0.5.0") },
  });
  expect(await archived()).toContain("spade/spade-server.exe");
});

test.runIf(posix)(
  "cargo builds it in release mode for the target, stamped with the release's version",
  async ({ onTestFinished }) => {
    const { dir, root, archived } = await release(onTestFinished);
    const how = await stageSpadeServer({
      repo: dir,
      root,
      target: "darwin-arm64",
      host: "darwin-arm64",
      version: "0.5.0",
      env: {},
      cargo: fakeCargo(dir, "aarch64-apple-darwin"),
    });
    expect(how).toBe("built");
    expect(await archived()).toContain("spade/spade-server");
  },
);

test("a release that can't build Spade fails loudly", async ({ onTestFinished }) => {
  const { dir, root } = await release(onTestFinished);
  await expect(
    stageSpadeServer({
      repo: dir,
      root,
      target: "linux-arm64",
      version: "0.5.0",
      env: {},
      cargo: noCargo,
    }),
  ).rejects.toThrow(/DISABLE_SPADE=1/);
  await expect(
    stageSpadeServer({
      repo: dir,
      root,
      target: "linux-arm64",
      version: "0.5.0",
      env: { ACE_SPADE_SERVER_BIN: join(dir, "missing") },
    }),
  ).rejects.toThrow(/missing/);
});

test.runIf(posix)(
  "DISABLE_SPADE=1 leaves spade-server out of the archive",
  async ({ onTestFinished }) => {
    const { dir, root, prebuilt, archived } = await release(onTestFinished);
    const how = await stageSpadeServer({
      repo: dir,
      root,
      target: "linux-x64",
      version: "0.5.0",
      env: { DISABLE_SPADE: "1", ACE_SPADE_SERVER_BIN: await prebuilt("0.5.0") },
      cargo: noCargo,
    });
    expect(how).toBe("disabled");
    expect(await archived()).toEqual(["bin/node", "release.json"]);
  },
);
