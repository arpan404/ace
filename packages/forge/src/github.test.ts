import { afterEach, describe, expect, it } from "vitest";
import { fakeGh, standard, pr, check, comment, sha, threads, thread } from "./testing/fixtures.ts";

const signal = () => new AbortController().signal;
const cleanups: (() => Promise<void>)[] = [];
async function setup(fixtures = standard(), options: { maxBytes?: number } = {}) {
  const result = await fakeGh(fixtures, options);
  cleanups.push(result.cleanup);
  return result;
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("GitHub CLI boundary", () => {
  it("reads paginated checks and review comments, preserving unknown PR fields", async () => {
    const fixtures = standard();
    const path = `repos/octo/ace/commits/${sha}/check-runs?per_page=100&filter=latest`;
    fixtures[path] = [
      {
        body: { check_runs: [check] },
        headers: {
          Link: `<https://api.github.com/repos/octo/ace/commits/${sha}/check-runs?page=2&per_page=100>; rel="next"`,
        },
      },
    ];
    fixtures[`repos/octo/ace/commits/${sha}/check-runs?page=2&per_page=100`] = [
      { body: { check_runs: [{ ...check, id: 12, name: "lint", conclusion: "success" }] } },
    ];
    fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [
      {
        body: [comment],
        headers: {
          Link: '<https://api.github.com/repos/octo/ace/pulls/7/comments?page=2>; rel="next"',
        },
      },
    ];
    fixtures["repos/octo/ace/pulls/7/comments?page=2"] = [
      { body: [{ ...comment, id: 14, body: "second" }] },
    ];
    const { forge } = await setup(fixtures);
    const status = await forge.status(7, signal());
    expect(status.checks.map((entry) => entry.name)).toEqual(["test", "lint"]);
    expect(status.comments.map((entry) => entry.body)).toEqual(["Handle empty input", "second"]);
    expect(status.reviewThreads[0]).toMatchObject({ resolved: false, file: "src/main.ts" });
    expect(status.raw).toMatchObject({ pr: { future_field: { useful: true } } });
    expect(status.ci).toBe("failure");
  });
  it("reuses per-resource ETags after 304 while still reading new comments", async () => {
    const fixtures = standard();
    fixtures["repos/octo/ace/pulls/7"] = [
      { body: pr, headers: { ETag: '"one"' } },
      { status: 304, raw: "", code: 1 },
    ];
    fixtures[`repos/octo/ace/commits/${sha}/check-runs?per_page=100&filter=latest`] = [
      { body: { check_runs: [check] }, headers: { ETag: '"checks"' } },
      { status: 304, raw: "", code: 1 },
    ];
    fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [
      { body: [comment], headers: { ETag: '"comments"' } },
      { body: [{ ...comment, id: 20, body: "new" }] },
    ];
    const { forge, requests } = await setup(fixtures);
    await forge.status(7, signal());
    const status = await forge.status(7, signal());
    expect(status.comments[0]?.body).toBe("new");
    expect(status.checks[0]?.status).toBe("failure");
    const calls = await requests();
    expect(calls.filter((request) => request.path === "repos/octo/ace/pulls/7")[1]?.args).toContain(
      'If-None-Match: "one"',
    );
    expect(calls.filter((request) => request.path.includes("check-runs"))[1]?.args).toContain(
      'If-None-Match: "checks"',
    );
  });
  it.each([404, 403, 429])(
    "classifies HTTP %s without exposing token-bearing stderr or bodies",
    async (code) => {
      const fixtures = standard();
      fixtures["repos/octo/ace/pulls/7"] = [
        {
          status: code,
          body: { message: "ghp_secret" },
          stderr: "Authorization: Bearer ghp_secret",
          headers: code === 429 ? { "Retry-After": "120" } : {},
        },
      ];
      const { forge } = await setup(fixtures);
      try {
        await forge.status(7, signal());
        throw new Error("Expected request failure");
      } catch (error) {
        expect(error).toMatchObject({
          kind: code === 404 ? "not_found" : code === 403 ? "forbidden" : "rate_limit",
          ...(code === 429 ? { retryAt: 121_000 } : {}),
        });
        expect(String(error)).not.toContain("ghp_secret");
      }
    },
  );
  it("treats exhausted 403 as rate limited and rejects malformed JSON and foreign pagination", async () => {
    let fixtures = standard();
    fixtures["repos/octo/ace/pulls/7"] = [
      { status: 403, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "61" } },
    ];
    let fake = await setup(fixtures);
    await expect(fake.forge.status(7, signal())).rejects.toMatchObject({
      kind: "rate_limit",
      retryAt: 61_000,
    });
    fixtures = standard();
    fixtures["repos/octo/ace/pulls/7"] = [{ raw: "{invalid ghp_secret" }];
    fake = await setup(fixtures);
    await expect(fake.forge.status(7, signal())).rejects.toMatchObject({ kind: "invalid_data" });
    fixtures = standard();
    fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [
      { body: [], headers: { Link: '<https://evil.test/data>; rel="next"' } },
    ];
    fake = await setup(fixtures);
    await expect(fake.forge.status(7, signal())).rejects.toMatchObject({ kind: "invalid_data" });
  });
  it("reads nested GraphQL pages and refuses to silently truncate a review", async () => {
    const fixtures = standard();
    const first = thread();
    first.comments.pageInfo = { hasNextPage: true, endCursor: null };
    // Missing cursor must be rejected rather than losing comments.
    fixtures.graphql = [{ body: threads([first]) }];
    let fake = await setup(fixtures);
    await expect(fake.forge.status(7, signal())).rejects.toMatchObject({ kind: "invalid_data" });
    const pageOne = {
      ...thread(),
      comments: { ...thread().comments, pageInfo: { hasNextPage: true, endCursor: "C1" } },
    };
    fixtures.graphql = [
      { body: threads([pageOne], true, "T1") },
      {
        body: {
          data: {
            node: {
              comments: {
                nodes: [{ databaseId: 50, body: "reply", author: null, updatedAt: "today" }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
      { body: threads([{ ...thread(), id: "THREAD_2" }]) },
    ];
    fake = await setup(fixtures);
    const status = await fake.forge.status(7, signal());
    expect(status.reviewThreads.map((entry) => entry.id)).toEqual(["THREAD_1", "THREAD_2"]);
    expect(status.reviewThreads[0]?.comments[1]).toMatchObject({
      id: 50,
      body: "reply",
      author: "ghost",
    });
  });
  it("creates templated PRs, replies, requests reviews and merges with a head guard", async () => {
    const fixtures = standard();
    fixtures["repos/octo/ace/pulls"] = [{ body: pr }];
    fixtures["repos/octo/ace/pulls/7/comments/13/replies"] = [{ body: { id: 80 } }];
    fixtures["repos/octo/ace/pulls/7/requested_reviewers"] = [
      { body: { requested_reviewers: [{ login: "alice" }] } },
    ];
    fixtures["repos/octo/ace/pulls/7/merge"] = [
      { body: { merged: true } },
      { body: { merged: false } },
    ];
    fixtures["auto-merge"] = [{ raw: "" }];
    const { forge, requests } = await setup(fixtures);
    expect(
      await forge.createPr(
        "thread1",
        {
          branch: "feat/fix",
          base: "main",
          title: "Fix CI",
          summary: "Tests pass",
          template: { title: "{{title}}", body: "{{summary}}\nThread {{threadId}} on {{branch}}" },
          draft: false,
        },
        signal(),
      ),
    ).toMatchObject({ number: 7 });
    await forge.replyComment(7, 13, "Fixed\nthanks", signal());
    await forge.requestReviews(7, ["alice"], signal());
    await forge.merge(7, sha, "squash", signal());
    await expect(forge.merge(7, sha, "squash", signal())).rejects.toMatchObject({
      kind: "conflict",
    });
    await forge.enableAutoMerge(7, sha, "squash", signal());
    const calls = await requests();
    expect(calls.find((call) => call.path === "repos/octo/ace/pulls")?.body).toEqual({
      head: "feat/fix",
      base: "main",
      title: "Fix CI",
      body: "Tests pass\nThread thread1 on feat/fix",
      draft: false,
    });
    expect(calls.find((call) => call.path.endsWith("/replies"))?.body).toEqual({
      body: "Fixed\nthanks",
    });
    expect(calls.find((call) => call.path.endsWith("requested_reviewers"))?.body).toEqual({
      reviewers: ["alice"],
    });
    expect(calls.find((call) => call.path.endsWith("/merge"))?.body).toEqual({
      sha,
      merge_method: "squash",
    });
    expect(calls.find((call) => call.path === "auto-merge")?.args).toEqual([
      "pr",
      "merge",
      "7",
      "--repo",
      "github.com/octo/ace",
      "--auto",
      "--squash",
      "--match-head-commit",
      sha,
    ]);
  });
  it("keeps only the latest legacy status per context and distinguishes issue and inline comments", async () => {
    const fixtures = standard();
    fixtures[`repos/octo/ace/commits/${sha}/statuses?per_page=100`] = [
      {
        body: [
          { id: 81, context: "deploy", state: "success", updated_at: "later", target_url: null },
          { id: 80, context: "deploy", state: "failure", updated_at: "earlier", target_url: null },
        ],
      },
    ];
    fixtures[`repos/octo/ace/commits/${sha}/check-runs?per_page=100&filter=latest`] = [
      { body: { check_runs: [] } },
    ];
    fixtures["repos/octo/ace/issues/7/comments?per_page=100"] = [
      { body: [{ ...comment, path: undefined, line: undefined, body: "General feedback" }] },
    ];
    const { forge } = await setup(fixtures);
    const status = await forge.status(7, signal());
    expect(status.ci).toBe("success");
    expect(status.checks.map((entry) => entry.id)).toEqual(["status:81"]);
    expect(status.comments.map((entry) => [entry.kind, entry.body])).toEqual([
      ["inline", "Handle empty input"],
      ["issue", "General feedback"],
    ]);
  });

  it("backs off secondary limits even when GitHub omits rate-limit headers", async () => {
    const fixtures = standard();
    fixtures["repos/octo/ace/pulls/7"] = [
      { status: 403, body: { message: "You have exceeded a secondary rate limit." } },
    ];
    const { forge } = await setup(fixtures);
    await expect(forge.status(7, signal())).rejects.toMatchObject({
      kind: "rate_limit",
      retryAt: 61_000,
    });
  });

  it("fails visibly when pagination loops or snapshot bytes exceed the budget", async () => {
    const fixtures = standard();
    const path = "repos/octo/ace/pulls/7/comments?per_page=100";
    fixtures[path] = [
      { body: [], headers: { Link: `<https://api.github.com/${path}>; rel="next"` } },
    ];
    let fake = await setup(fixtures);
    await expect(fake.forge.status(7, signal())).rejects.toMatchObject({ kind: "limit" });
    const bigPage = Array.from({ length: 50 }, (_, index) => ({
      ...comment,
      id: index + 1,
      body: "x".repeat(60_000),
    }));
    fixtures[path] = [
      {
        body: bigPage,
        headers: {
          Link: '<https://api.github.com/repos/octo/ace/pulls/7/comments?page=2>; rel="next"',
        },
      },
    ];
    fixtures["repos/octo/ace/pulls/7/comments?page=2"] = [
      {
        body: bigPage,
        headers: {
          Link: '<https://api.github.com/repos/octo/ace/pulls/7/comments?page=3>; rel="next"',
        },
      },
    ];
    fixtures["repos/octo/ace/pulls/7/comments?page=3"] = [{ body: bigPage }];
    fake = await setup(fixtures);
    await expect(fake.forge.status(7, signal())).rejects.toMatchObject({ kind: "limit" });
  });

  it("streams large logs while capping JSON output before decoding", async () => {
    const fixtures = standard();
    fixtures["repos/octo/ace/actions/jobs/99/logs"] = [
      { repeat: 100_000, text: "build line\n", suffix: "ghp_private123\nlast failure\n" },
    ];
    fixtures["repos/octo/ace/pulls/7"] = [{ repeat: 2_000, text: "long" }];
    const { forge } = await setup(fixtures, { maxBytes: 1_024 });
    const tail = await forge.logTail(99, signal());
    expect(Buffer.byteLength(tail.text)).toBeLessThanOrEqual(16_384);
    expect(tail.truncated).toBe(true);
    expect(tail.text.endsWith("[REDACTED]\nlast failure\n")).toBe(true);
    await expect(forge.status(7, signal())).rejects.toMatchObject({ kind: "limit" });
  });
});

describe("Deck publication recovery", () => {
  it("looks up a remotely created PR by its exact branch and base", async () => {
    const fixtures = standard();
    const query = new URLSearchParams({
      state: "all",
      head: "octo:deck/card",
      base: "main",
      per_page: "2",
    });
    fixtures[`repos/octo/ace/pulls?${query}`] = [
      { body: [{ ...pr, head: { sha, ref: "deck/card" }, base: { ref: "main" } }] },
    ];
    const { forge } = await setup(fixtures);
    expect(await forge.findPr("deck/card", "main", signal())).toMatchObject({ number: 7 });
  });
  it("does not accept a branch lookup that returns a different head or multiple PRs", async () => {
    const query = new URLSearchParams({
      state: "all",
      head: "octo:deck/card",
      base: "main",
      per_page: "2",
    });
    const wrong = standard();
    wrong[`repos/octo/ace/pulls?${query}`] = [{ body: [{ ...pr, base: { ref: "main" } }] }];
    const first = await setup(wrong);
    await expect(first.forge.findPr("deck/card", "main", signal())).rejects.toMatchObject({
      kind: "invalid_data",
    });
    const ambiguous = standard();
    ambiguous[`repos/octo/ace/pulls?${query}`] = [
      {
        body: [
          { ...pr, base: { ref: "main" } },
          { ...pr, number: 8, base: { ref: "main" } },
        ],
      },
    ];
    const second = await setup(ambiguous);
    await expect(second.forge.findPr("deck/card", "main", signal())).rejects.toMatchObject({
      kind: "conflict",
    });
  });
});
