import { mkdir, mkdtemp, rm, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import {
  assertTestGitDirectory,
  assertTestHomeIsolation,
  createTestHomeGuard,
} from "@ace/provider-kit/test-isolation";

test("an inactive test guard accepts paths without inspecting even a cyclic filesystem alias", async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "ace-inactive-guard-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const loop = path.join(root, "loop");
  await symlink(loop, loop);
  vi.stubEnv("ACE_TEST_REAL_HOME", undefined);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  expect(() => assertTestHomeIsolation(path.join(loop, "missing/file"))).not.toThrow();
  expect(await readdir(root)).toEqual(["loop"]);
});

test("a missing protected root is guarded through its canonical ancestor", async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "ace-absent-guard-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const ancestor = path.join(root, "ancestor"),
    alias = path.join(root, "alias");
  await mkdir(ancestor);
  await symlink(ancestor, alias, "junction");
  vi.stubEnv("ACE_TEST_REAL_HOME", path.join(alias, "absent"));
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  expect(() => assertTestHomeIsolation(path.join(ancestor, "absent/deep/data"))).toThrow(
    /ACE_TEST_REAL_HOME guard/,
  );
  expect(() => assertTestHomeIsolation(path.join(ancestor, "absent-other/data"))).not.toThrow();
  expect(await readdir(ancestor)).toEqual([]);
});

test("Windows home policy accepts another drive and siblings but rejects same-drive descendants and dot-dot names", () => {
  const guard = createTestHomeGuard("C:\\Users\\owner", {
    cwd: "C:\\work",
    paths: path.win32,
    realpath: (candidate) => candidate,
  });
  expect(() => guard("D:\\Users\\owner\\data")).not.toThrow();
  expect(() => guard("C:\\Users\\owner-other\\data")).not.toThrow();
  expect(() => guard("C:\\Users\\owner")).toThrow(/ACE_TEST_REAL_HOME guard/);
  expect(() => guard("C:\\Users\\OWNER\\..cache\\data")).toThrow(/ACE_TEST_REAL_HOME guard/);
  expect(() => guard("C:\\Users\\owner\\missing\\data")).toThrow(/ACE_TEST_REAL_HOME guard/);
});

test("a fixture git cwd that is relative, missing or outside the temp root is refused", async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "ace-git-cwd-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const temporary = path.join(root, "tmp");
  const fixture = path.join(temporary, "repo");
  const outside = path.join(root, "checkout");
  await mkdir(fixture, { recursive: true });
  await mkdir(outside);
  await symlink(outside, path.join(temporary, "alias"));
  expect(assertTestGitDirectory(fixture, temporary)).toBe(fixture);
  expect(() => assertTestGitDirectory("repo", temporary)).toThrow(/must be absolute/);
  expect(() => assertTestGitDirectory(path.join(temporary, "never-created"), temporary)).toThrow(
    /ENOENT/,
  );
  expect(() => assertTestGitDirectory(outside, temporary)).toThrow(/outside the test temp root/);
  expect(() => assertTestGitDirectory(path.join(temporary, "alias"), temporary)).toThrow(
    /outside the test temp root/,
  );
});
