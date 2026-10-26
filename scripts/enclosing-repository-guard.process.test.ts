import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { testGitEnvironment } from "@ace/provider-kit/test-isolation";
import {
  captureEnclosingRepository,
  verifyEnclosingRepository,
} from "./enclosing-repository-guard.ts";
import { isolatedTestEnvironment } from "./test-home-policy.ts";

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = testGitEnvironment()) {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A checkout with one linked worktree, like the agent worktrees tests are started from. */
function checkout(onTestFinished: (cleanup: () => void) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ace-enclosing-")));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, "main");
  const linked = join(root, "linked");
  git(root, ["init", "-q", "-b", "main", main]);
  git(main, ["commit", "-q", "--allow-empty", "-m", "initial"]);
  git(main, ["worktree", "add", "-q", "-b", "agent", linked]);
  return { root, main, linked };
}

test("a test that flips core.bare through a linked worktree fails the run and the checkout is put back", ({
  onTestFinished,
}) => {
  const { main, linked } = checkout(onTestFinished);
  const repository = captureEnclosingRepository(linked);
  // What a fixture `git config` with a cwd that fell back to the agent worktree does.
  git(linked, ["config", "core.bare", "true"]);
  expect(() => git(main, ["status", "--short"])).toThrow(/work tree/);

  expect(() => verifyEnclosingRepository(repository, "broken.process.test.ts")).toThrow(
    /broken\.process\.test\.ts[\s\S]*core\.bare false -> true[\s\S]*Restored core\.bare/,
  );
  expect(git(main, ["status", "--short"])).toBe("");
});

test("ordinary config another agent writes while tests run is not reported", ({
  onTestFinished,
}) => {
  const { main, linked } = checkout(onTestFinished);
  const repository = captureEnclosingRepository(linked);
  git(main, ["config", "branch.feature.remote", "origin"]);
  git(linked, ["config", "rerere.enabled", "true"]);
  expect(() => verifyEnclosingRepository(repository, "fine.process.test.ts")).not.toThrow();
});

test("fixture git in the test environment cannot reinitialize a checkout named by an inherited GIT_DIR", ({
  onTestFinished,
}) => {
  const { root, main, linked } = checkout(onTestFinished);
  const home = join(root, "home");
  const env = isolatedTestEnvironment(
    { ...process.env, GIT_DIR: join(main, ".git", "worktrees", "linked") },
    home,
    process.env.ACE_TEST_REAL_HOME ?? join(root, "real-home"),
    process.platform,
  );
  const remote = join(root, "remote.git");
  mkdirSync(remote);
  // With GIT_DIR inherited, this exact call sets core.bare = true on the shared checkout config.
  git(remote, ["init", "-q", "--bare"], env);
  expect(existsSync(join(remote, "HEAD"))).toBe(true);
  expect(git(main, ["config", "core.bare"])).toBe("false");
  expect(git(linked, ["status", "--short"])).toBe("");
});

test("fixture git started below a guarded checkout cannot discover it", ({ onTestFinished }) => {
  const { root, linked } = checkout(onTestFinished);
  const nested = join(linked, "fixture-that-failed-to-init");
  mkdirSync(nested);
  const repository = captureEnclosingRepository(linked);
  const env = isolatedTestEnvironment(
    process.env,
    join(root, "home"),
    process.env.ACE_TEST_REAL_HOME ?? join(root, "real-home"),
    process.platform,
    repository?.checkouts,
  );
  expect(() => git(nested, ["config", "core.bare", "true"], env)).toThrow(/not in a git directory/);
  expect(git(linked, ["config", "core.bare"])).toBe("false");
});
