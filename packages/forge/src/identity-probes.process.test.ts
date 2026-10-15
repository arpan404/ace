import { afterEach, expect, test } from "vitest";
import { GitHubForge, identityRunner } from "./index.ts";
import { fakeGh, repository, standard } from "./testing/fixtures.ts";

const signal = () => new AbortController().signal;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

test("PR status reads share one identity probe instead of probing around every request", async () => {
  const fixtures = standard();
  fixtures.user = [{ body: { login: "octo" } }];
  const gh = await fakeGh(fixtures);
  cleanups.push(gh.cleanup);
  let clock = 1_000;
  const forge = new GitHubForge({
    repository,
    now: () => clock,
    runner: identityRunner(
      (request) => gh.runner({ ...request, command: gh.executable }),
      repository.host,
      "octo",
      () => {},
      { now: () => clock },
    ),
  });
  await forge.status(7, signal());
  const first = await gh.requests();
  const reads = first.filter((request) => request.path !== "user").length;
  // N resource reads plus a single /user probe, not one before and after each read.
  expect(first).toHaveLength(reads + 1);
  clock += 1_000;
  await forge.status(7, signal());
  expect((await gh.requests()).filter((request) => request.path === "user")).toHaveLength(1);
  clock += 60_000;
  await forge.status(7, signal());
  expect((await gh.requests()).filter((request) => request.path === "user")).toHaveLength(2);
});

test("a rate-limited identity probe is a rate limit, not a denial", async () => {
  const fixtures = standard();
  fixtures.user = [
    {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "5000" },
      body: { message: "API rate limit exceeded for user." },
    },
  ];
  const gh = await fakeGh(fixtures);
  cleanups.push(gh.cleanup);
  const forge = new GitHubForge({
    repository,
    now: () => 1_000,
    runner: identityRunner(
      (request) => gh.runner({ ...request, command: gh.executable }),
      repository.host,
      "octo",
    ),
  });
  await expect(forge.status(7, signal())).rejects.toMatchObject({
    kind: "rate_limit",
    retryAt: 5_000_000,
  });
});
