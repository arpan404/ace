import { expect, test } from "vitest";
import {
  fakeGh,
  reviewFixtures,
  reviewHost,
  reviewViewed,
  repository,
  sha,
} from "./testing/fixtures.ts";
import { GitHubForge, reviewWriteMarker } from "./index.ts";
const signal = () => new AbortController().signal;
const allowed = () => true;

test("conversation comments and replies publish to the selected PR and reconcile the original publication", async () => {
  for (const reply of [false, true]) {
    const fixtures = reviewFixtures();
    const body = `Response\n\n${reviewWriteMarker("post")}`;
    const original = { id: 5, body: "Original", user: { login: "author" } };
    const posted = {
      id: 6,
      body,
      user: { login: "reviewer" },
      ...(reply ? { in_reply_to_id: 5 } : {}),
    };
    const read = `repos/octo/ace/${reply ? "pulls" : "issues"}/7/comments?per_page=100`;
    const write = reply
      ? "repos/octo/ace/pulls/7/comments/5/replies"
      : "repos/octo/ace/issues/7/comments";
    fixtures[read] = reply
      ? [{ body: [original] }, { body: [original, posted] }]
      : [{ body: [posted] }];
    fixtures[write] = [{ body: posted }];
    const action = reply
      ? { kind: "reply" as const, commentId: 5, body: "Response" }
      : { kind: "conversation" as const, body: "Response" };
    const f = await fakeGh(fixtures);
    try {
      await f.forge.reviews.write(7, action, [], "post", signal(), allowed);
      expect(await f.forge.reviews.reconcile(7, action, "post", signal())).toBe(true);
      expect(
        (await f.requests()).find((r) => r.path === write && r.args.includes("POST"))?.body,
      ).toEqual({ body });
    } finally {
      await f.cleanup();
    }
  }
});

test("own issue and inline comments can be edited and deleted with host-observed results", async () => {
  for (const source of ["issue", "inline"] as const) {
    const fixtures = reviewFixtures();
    const original = { id: 5, body: "Original", user: { login: "reviewer" } };
    const edited = { ...original, body: "Edited" };
    fixtures[`repos/octo/ace/${source === "inline" ? "pulls" : "issues"}/7/comments?per_page=100`] =
      [{ body: [original] }, { body: [edited] }, { body: [edited] }, { body: [] }];
    const path = `repos/octo/ace/${source === "inline" ? "pulls" : "issues"}/comments/5`;
    fixtures[path] = [{ body: edited }, { status: 204 }];
    const f = await fakeGh(fixtures);
    const edit = {
      kind: "comment.edit",
      source,
      commentId: 5,
      expectedBody: "Original",
      body: "Edited",
    } as const;
    const remove = {
      kind: "comment.delete",
      source,
      commentId: 5,
      expectedBody: "Edited",
    } as const;
    try {
      await f.forge.reviews.write(7, edit, [], "edit", signal(), allowed);
      expect(await f.forge.reviews.reconcile(7, edit, "edit", signal())).toBe(true);
      await f.forge.reviews.write(7, remove, [], "delete", signal(), allowed);
      expect(await f.forge.reviews.reconcile(7, remove, "delete", signal())).toBe(true);
      const requests = await f.requests();
      expect(requests.find((r) => r.path === path && r.args.includes("PATCH"))?.body).toEqual({
        body: "Edited",
      });
      expect(requests.some((r) => r.path === path && r.args.includes("DELETE"))).toBe(true);
    } finally {
      await f.cleanup();
    }
  }
});

test("resolve and unresolve mutations use the selected hosted thread and expose its resulting state", async () => {
  const fixtures = reviewFixtures();
  const unresolved = reviewHost();
  const resolved = reviewHost({
    reviewThreads: {
      ...unresolved.data.repository.pullRequest.reviewThreads,
      nodes: [{ id: "T_7", isResolved: true, viewerCanResolve: true, viewerCanUnresolve: true }],
    },
  });
  fixtures["graphql:viewer { login }"] = [
    { body: unresolved },
    { body: resolved },
    { body: resolved },
    { body: unresolved },
  ];
  for (const name of ["resolveReviewThread", "unresolveReviewThread"])
    fixtures[`graphql:mutation($input:${name[0]?.toUpperCase()}${name.slice(1)}Input!`] = [
      { body: { data: { [name]: { clientMutationId: name } } } },
    ];
  const f = await fakeGh(fixtures);
  try {
    for (const kind of ["thread.resolve", "thread.unresolve"] as const) {
      const action = { kind, threadId: "T_7" };
      await f.forge.reviews.write(7, action, [], kind, signal(), allowed);
      expect(await f.forge.reviews.reconcile(7, action, kind, signal())).toBe(true);
    }
    const mutations = (await f.requests()).filter(
      (r) =>
        typeof r.body === "object" &&
        r.body !== null &&
        "query" in r.body &&
        typeof r.body.query === "string" &&
        r.body.query.startsWith("mutation"),
    );
    expect(mutations.map((r) => r.body)).toEqual([
      {
        query: expect.stringContaining("resolveReviewThread(input:$input)"),
        variables: { input: { threadId: "T_7", clientMutationId: "thread.resolve" } },
      },
      {
        query: expect.stringContaining("unresolveReviewThread(input:$input)"),
        variables: { input: { threadId: "T_7", clientMutationId: "thread.unresolve" } },
      },
    ]);
  } finally {
    await f.cleanup();
  }
});

test("view and unview marks written by one client are visible through another client backend", async () => {
  const fixtures = reviewFixtures();
  fixtures["graphql:files(first:"] = ["UNVIEWED", "VIEWED", "VIEWED", "UNVIEWED"].map((state) => ({
    body: reviewViewed(state),
  }));
  for (const name of ["markFileAsViewed", "unmarkFileAsViewed"])
    fixtures[`graphql:mutation($input:${name[0]?.toUpperCase()}${name.slice(1)}Input!`] = [
      { body: { data: { [name]: { clientMutationId: name } } } },
    ];
  const f = await fakeGh(fixtures);
  const other = new GitHubForge({
    repository,
    runner: f.runner,
    command: f.executable,
    now: () => 2_000,
  });
  try {
    await f.forge.reviews.write(
      7,
      { kind: "file.view", path: "src/main.ts", headSha: sha },
      [],
      "view",
      signal(),
      allowed,
    );
    expect(await other.reviews.viewed(7, sha, signal())).toEqual([
      { path: "src/main.ts", state: "VIEWED" },
    ]);
    await other.reviews.write(
      7,
      { kind: "file.unview", path: "src/main.ts", headSha: sha },
      [],
      "unview",
      signal(),
      allowed,
    );
    expect(await f.forge.reviews.viewed(7, sha, signal())).toEqual([
      { path: "src/main.ts", state: "UNVIEWED" },
    ]);
    const mutations = (await f.requests()).filter(
      (r) =>
        typeof r.body === "object" &&
        r.body !== null &&
        "query" in r.body &&
        typeof r.body.query === "string" &&
        r.body.query.startsWith("mutation"),
    );
    expect(mutations.map((r) => r.body)).toEqual([
      {
        query: expect.stringContaining("markFileAsViewed(input:$input)"),
        variables: {
          input: { pullRequestId: "PR_7", path: "src/main.ts", clientMutationId: "view" },
        },
      },
      {
        query: expect.stringContaining("unmarkFileAsViewed(input:$input)"),
        variables: {
          input: { pullRequestId: "PR_7", path: "src/main.ts", clientMutationId: "unview" },
        },
      },
    ]);
  } finally {
    await f.cleanup();
  }
});
