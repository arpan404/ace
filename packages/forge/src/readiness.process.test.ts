import { afterEach, expect, it } from "vitest";
import {
  githubReadiness,
  githubIdentity,
  identityRunner,
  createCommandRunner,
  prFromUrl,
  repositoryFromRemote,
} from "./index.ts";
import { readinessGh } from "./testing/readiness-gh.ts";
const cleanups: (() => Promise<void>)[] = [];
const signal = () => new AbortController().signal;
const preferences = { hosts: [{ host: "github.com" }], host: "github.com", remote: "origin" };
async function setup(input: Parameters<typeof readinessGh>[0] = {}) {
  const f = await readinessGh(input);
  cleanups.push(f.cleanup);
  return f;
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
it("older CLIs expose effective API identity without needing JSON auth status", async () => {
  const f = await setup();
  const status = await githubReadiness(f.runner, preferences, signal());
  expect(status).toMatchObject({
    cli: "available",
    version: "2.90.0",
    account: "octo",
    api: "ready",
    transport: "unchecked",
  });
});
it("rescan discovers login changes and reports expected-account mismatches", async () => {
  const f = await setup({ fail: true });
  expect(await githubReadiness(f.runner, preferences, signal())).toMatchObject({
    api: "login_required",
    account: null,
  });
  await f.update({ account: "other", modern: true });
  const status = await githubReadiness(
    f.runner,
    { ...preferences, hosts: [{ host: "github.com", account: "octo" }] },
    signal(),
  );
  expect(status.api).toBe("account_mismatch");
  expect(status.accounts).toContainEqual({ login: "other", active: false });
  expect(status.instructions).toContain("gh auth switch --hostname github.com --user octo");
});
it("missing CLI gives installation instructions without leaking process errors", async () => {
  const f = await setup();
  const status = await githubReadiness(
    createCommandRunner({ cwd: f.directory, env: { PATH: "/nonexistent" } }),
    preferences,
    signal(),
  );
  expect(status.cli).toBe("unavailable");
  expect(status.instructions).toContain("Install GitHub CLI");
});
it("overlapping requests with different expected accounts cannot silently switch identity", async () => {
  const f = await setup();
  const request = {
    command: "gh",
    args: ["api", "repos/octo/ace"],
    mode: "json" as const,
    signal: signal(),
  };
  const [octo, other] = await Promise.allSettled([
    identityRunner(f.runner, "github.com", "octo")(request),
    identityRunner(f.runner, "github.com", "other")(request),
  ]);
  expect(octo.status).toBe("fulfilled");
  expect(other.status).toBe("rejected");
  expect(await githubIdentity(f.runner, "github.com", signal())).toBe("octo");
});
it("identity changes during an operation reject stale results", async () => {
  const f = await setup({ changeAfter: true });
  await expect(
    identityRunner(
      f.runner,
      "github.com",
      "octo",
    )({ command: "gh", args: ["api", "repos/octo/ace"], mode: "json", signal: signal() }),
  ).rejects.toMatchObject({ kind: "forbidden" });
});
it("malformed identity never admits an authenticated operation", async () => {
  const f = await setup({ malformed: true });
  await expect(githubIdentity(f.runner, "github.com", signal())).rejects.toMatchObject({
    kind: "invalid_data",
  });
});
it("configured Enterprise hosts reach remote detection and PR URL linking", () => {
  const repo = repositoryFromRemote("git@git.example.com:octo/ace.git", {
    "git.example.com": "github",
  });
  expect(prFromUrl("https://git.example.com/octo/ace/pull/7", ["git.example.com"])).toEqual({
    repository: repo,
    number: 7,
  });
  expect(() => prFromUrl("https://unconfigured.example.com/octo/ace/pull/7")).toThrow();
});
it("cancellation stops a guarded CLI operation", async () => {
  const f = await setup({ wait: true });
  const controller = new AbortController();
  const result = identityRunner(
    f.runner,
    "github.com",
    "octo",
  )({ command: "gh", args: ["api", "repos/octo/ace"], mode: "json", signal: controller.signal });
  controller.abort();
  await expect(result).rejects.toMatchObject({ kind: "cancelled" });
});
