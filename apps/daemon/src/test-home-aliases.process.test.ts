import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { assertTestHomeIsolation, prepareDaemonHome, resolveDaemonHome } from "@ace/service";
import { readConfig } from "./config.ts";
import { testHomeEnvironment } from "../../../scripts/test-home-environment.ts";
import { testHomes, ownedDaemonAttempt, daemonConfig } from "./testing/test-home-fixture.ts";

test("a home alias and its absent descendants cannot enter protected homes", async ({
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

test("a protected home, or an alias of it, is refused before a fresh start can move or create anything", async ({
  onTestFinished,
}) => {
  const { root, protectedHome } = await testHomes(onTestFinished);
  const alias = join(root, "alias");
  await mkdir(join(protectedHome, ".ace"));
  await writeFile(join(protectedHome, ".ace/ace.db"), "legacy bytes");
  await symlink(protectedHome, alias, "junction");
  vi.stubEnv("ACE_TEST_REAL_HOME", protectedHome);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  for (const home of [join(protectedHome, ".ace"), join(alias, ".ace"), join(alias, "absent")])
    expect(() => prepareDaemonHome(home)).toThrow(/ACE_TEST_REAL_HOME guard/);
  expect(await readdir(protectedHome)).toEqual([".ace"]);
  expect(await readFile(join(protectedHome, ".ace/ace.db"), "utf8")).toBe("legacy bytes");
});
