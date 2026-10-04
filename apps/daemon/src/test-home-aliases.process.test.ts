import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { assertTestHomeIsolation, resolveDaemonHome } from "@ace/service";
import { readConfig } from "./config.ts";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createDaemonHomeResolver } from "@ace/service";
import { createTestHomeGuard } from "@ace/provider-kit/test-isolation";
import { PinnedDirectory } from "@ace/workspace/pinned-directory";
import { testHomeEnvironment } from "../../../scripts/test-home-environment.ts";
import { testHomes, ownedDaemonAttempt, daemonConfig } from "./testing/test-home-fixture.ts";

test("a home alias and its absent descendants cannot enter protected homes or publish legacy markers", async ({
  onTestFinished,
}) => {
  const { root, protectedHome, safeHome } = await testHomes(onTestFinished);
  const alias = join(root, "alias");
  await mkdir(join(protectedHome, ".ace"));
  await writeFile(join(protectedHome, ".ace/host-id"), "protected compatible home");
  await mkdir(join(protectedHome, "child/.ace"), { recursive: true });
  await writeFile(join(protectedHome, "child/.ace/ace.db"), "legacy bytes");
  await symlink(protectedHome, alias, "junction");
  vi.stubEnv("ACE_TEST_REAL_HOME", protectedHome);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  for (const dataDir of [join(alias, ".ace"), join(alias, "absent/nested/data")]) {
    expect(() => readConfig({ ACE_HOME: dataDir }, safeHome)).toThrow(/ACE_TEST_REAL_HOME guard/);
    await expect(
      ownedDaemonAttempt(onTestFinished, { config: daemonConfig(dataDir) }),
    ).rejects.toThrow(/ACE_TEST_REAL_HOME guard/);
  }
  expect(() => resolveDaemonHome(join(alias, "child"))).toThrow(/ACE_TEST_REAL_HOME guard/);
  expect(() => assertTestHomeIsolation(join(alias, "absent/nested/accounts.sqlite"))).toThrow(
    /ACE_TEST_REAL_HOME guard/,
  );
  expect(() => testHomeEnvironment(join(alias, "absent/worker"), protectedHome)).toThrow(
    /ACE_TEST_REAL_HOME guard/,
  );
  expect(await readdir(protectedHome)).toEqual([".ace", "child"]);
  expect(await readdir(join(protectedHome, "child"))).toEqual([".ace"]);
  expect(await readFile(join(protectedHome, "child/.ace/ace.db"), "utf8")).toBe("legacy bytes");
  expect(await readFile(join(protectedHome, ".ace/host-id"), "utf8")).toBe(
    "protected compatible home",
  );
});

test("aliases of the protected root remain protected even when their data directories are missing", async ({
  onTestFinished,
}) => {
  const { root, protectedHome, safeHome } = await testHomes(onTestFinished);
  const alias = join(root, "protected-alias");
  await symlink(protectedHome, alias, "junction");
  vi.stubEnv("ACE_TEST_REAL_HOME", alias);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  expect(() => readConfig({ ACE_HOME: join(protectedHome, "missing/data") }, safeHome)).toThrow(
    /ACE_TEST_REAL_HOME guard/,
  );
  expect(await readdir(protectedHome)).toEqual([]);
});

test("an injected resolver refuses protected homes before their filesystem boundary can publish a receipt", async ({
  onTestFinished,
}) => {
  const { protectedHome } = await testHomes(onTestFinished);
  const receipt = join(protectedHome, "boundary-receipt");
  const resolver = createDaemonHomeResolver({
    assertSafePath: createTestHomeGuard(protectedHome, {
      cwd: import.meta.dirname,
      paths: path,
      realpath: realpathSync,
    }),
    open(candidate) {
      // Observe an actual filesystem effect if the decision ever admits this boundary.
      writeFileSync(receipt, "opened");
      return PinnedDirectory.atBoundary(candidate);
    },
  });
  expect(() => resolver(protectedHome)).toThrow(/ACE_TEST_REAL_HOME guard/);
  expect(() => readFileSync(receipt, "utf8")).toThrow(/ENOENT/);
  expect(await readdir(protectedHome)).toEqual([]);
});
