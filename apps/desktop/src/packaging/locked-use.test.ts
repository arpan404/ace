import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { daemonEnvironment } from "../main/daemon/spawn.ts";
import { appPaths } from "../main/paths.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ace-locked-package-"));
  roots.push(root);
  const paths = appPaths({
    appDirectory: join(root, "app.asar"),
    resourcesPath: root,
    platform: "darwin",
    packaged: true,
  });
  const directory = join(root, "locked-use");
  return {
    directory,
    env: () =>
      daemonEnvironment(
        {
          home: "/fixture",
          version: "0.1.0",
          path: "/usr/bin",
          env: { ACE_LOCKED_USE_TEAM: "INHERITED1", ACE_LOCKED_USE_PLUGIN: "/untrusted/plugin" },
          resources: {
            entry: paths.daemonEntry,
            packaged: true,
            lockedUseDirectory: paths.lockedUseDirectory,
          },
        },
        {},
      ),
  };
}

test("a signed package supplies its own components and team to the daemon", async () => {
  const f = await fixture();
  await mkdir(f.directory, { recursive: true });
  await writeFile(join(f.directory, "manifest.json"), '{"team":"ABCDE12345"}');
  await mkdir(join(f.directory, "AceLockedUseAuthorization.bundle"));
  await writeFile(join(f.directory, "ace-locked-use-authority"), "fixture");
  await writeFile(join(f.directory, "ace-locked-use-guardian"), "fixture");
  expect(f.env()).toMatchObject({
    ACE_LOCKED_USE_TEAM: "ABCDE12345",
    ACE_LOCKED_USE_PLUGIN: join(f.directory, "AceLockedUseAuthorization.bundle"),
    ACE_LOCKED_USE_BROKER: join(f.directory, "ace-locked-use-authority"),
    ACE_LOCKED_USE_GUARDIAN: join(f.directory, "ace-locked-use-guardian"),
  });
});

test("an unsigned package cannot inherit a privileged runner from its launch environment", async () => {
  const f = await fixture();
  expect(f.env().ACE_LOCKED_USE_TEAM).toBeUndefined();
  expect(f.env().ACE_LOCKED_USE_PLUGIN).toBeUndefined();
});

test("partial or malformed locked-use packages refuse startup", async () => {
  const f = await fixture();
  await mkdir(f.directory);
  expect(f.env).toThrow("manifest is missing");
  await writeFile(join(f.directory, "manifest.json"), '{"team":"ABCDE12345"}');
  expect(f.env).toThrow("packaged locked-use component is missing");
  await mkdir(f.directory, { recursive: true });
  await writeFile(join(f.directory, "manifest.json"), '{"team":"invalid"}');
  expect(f.env).toThrow();
});
