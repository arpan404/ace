import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { ForgeStore, ReviewLoop } from "./index.ts";
import type { ForgeAutoFixIntent } from "@ace/protocol/forge";
import {
  fakeGh,
  standard,
  repository,
  pr,
  check,
  comment,
  sha,
  nextSha,
  threads,
  thread,
} from "./testing/fixtures.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).toReversed()) await action();
});
const link = { threadId: "regression", pr: { repository, number: 7 } };
const signal = () => new AbortController().signal;
async function setup(fixtures = standard()) {
  const fake = await fakeGh(fixtures);
  cleanup.push(fake.cleanup);
  const db = new DatabaseSync(":memory:");
  cleanup.push(async () => {
    db.close();
  });
  const store = new ForgeStore(db);
  store.link(link);
  return { ...fake, store };
}
it("queues paginated summary-only submitted reviews with distinct review identities", async () => {
  const fixtures = standard();
  fixtures[`repos/octo/ace/commits/${sha}/check-runs?per_page=100&filter=latest`] = [
    { body: { check_runs: [] } },
  ];
  fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [{ body: [] }];
  fixtures.graphql = [{ body: threads() }];
  fixtures["repos/octo/ace/pulls/7/reviews?per_page=100"] = [
    {
      body: [
        {
          id: 13,
          body: "Fix the error handling",
          state: "CHANGES_REQUESTED",
          user: { login: "alice" },
          submitted_at: "today",
        },
      ],
      headers: {
        Link: '<https://api.github.com/repos/octo/ace/pulls/7/reviews?page=2>; rel="next"',
      },
    },
  ];
  fixtures["repos/octo/ace/pulls/7/reviews?page=2"] = [
    {
      body: [
        {
          id: 14,
          body: "Use a typed return",
          state: "COMMENTED",
          user: { login: "bob" },
          submitted_at: "today",
        },
        {
          id: 15,
          body: "Looks good",
          state: "APPROVED",
          user: { login: "carol" },
          submitted_at: "today",
        },
        {
          id: 16,
          body: "Old request",
          state: "DISMISSED",
          user: { login: "dave" },
          submitted_at: "today",
        },
      ],
    },
  ];
  const { forge, store } = await setup(fixtures);
  const intents: ForgeAutoFixIntent[] = [];
  const loop = new ReviewLoop({
    forge,
    store,
    executor: {
      async enqueue(intent) {
        intents.push(intent);
      },
    },
  });
  const status = await loop.poll(link.threadId, signal());
  expect(status.comments.map((entry) => entry.body)).toContain("Fix the error handling");
  expect(intents.map((intent) => intent.context)).toMatchObject([
    {
      type: "review",
      comment: { kind: "review", id: 13, body: "Fix the error handling", file: null, line: null },
    },
    {
      type: "review",
      comment: { kind: "review", id: 14, body: "Use a typed return", file: null, line: null },
    },
  ]);
});
it.each(["merged", "closed", "fixed", "resolved"])(
  "drops rejected pending feedback after the PR becomes %s",
  async (change) => {
    const fixtures = standard();
    fixtures["repos/octo/ace/pulls/7"] = [
      { body: pr },
      {
        body:
          change === "merged"
            ? { ...pr, state: "closed", merged: true }
            : change === "closed"
              ? { ...pr, state: "closed" }
              : pr,
      },
    ];
    fixtures[`repos/octo/ace/commits/${sha}/check-runs?per_page=100&filter=latest`] = [
      { body: { check_runs: [check] } },
      {
        body: {
          check_runs: ["merged", "closed"].includes(change)
            ? [check]
            : [{ ...check, conclusion: "success" }],
        },
      },
    ];
    fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [
      { body: [comment] },
      { body: change === "fixed" ? [] : [comment] },
    ];
    fixtures.graphql = [
      { body: threads([thread()]) },
      { body: threads(change === "fixed" ? [] : [thread(change === "resolved")]) },
    ];
    const { forge, store } = await setup(fixtures);
    let reject = true;
    const delivered: ForgeAutoFixIntent[] = [];
    const loop = new ReviewLoop({
      forge,
      store,
      executor: {
        async enqueue(intent) {
          if (reject) {
            reject = false;
            throw new Error("not accepted");
          }
          delivered.push(intent);
        },
      },
    });
    await expect(loop.poll(link.threadId, signal())).rejects.toMatchObject({ kind: "cli" });
    await loop.poll(link.threadId, signal());
    expect(delivered).toEqual([]);
    expect(store.pending(link.threadId)).toEqual([]);
  },
);
it("replaces rejected feedback with current head and edited text before retrying", async () => {
  const fixtures = standard();
  fixtures["repos/octo/ace/pulls/7"] = [
    { body: pr },
    { body: { ...pr, head: { ...pr.head, sha: nextSha } } },
  ];
  fixtures[`repos/octo/ace/commits/${nextSha}/check-runs?per_page=100&filter=latest`] = [
    { body: { check_runs: [check] } },
  ];
  fixtures[`repos/octo/ace/commits/${nextSha}/statuses?per_page=100`] = [{ body: [] }];
  fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [
    { body: [comment] },
    { body: [{ ...comment, body: "Current feedback", updated_at: "later" }] },
  ];
  fixtures.graphql = [{ body: threads() }];
  const { forge, store } = await setup(fixtures);
  let reject = true;
  const delivered: ForgeAutoFixIntent[] = [];
  const loop = new ReviewLoop({
    forge,
    store,
    executor: {
      async enqueue(intent) {
        if (reject) {
          reject = false;
          throw new Error("not accepted");
        }
        delivered.push(intent);
      },
    },
  });
  await expect(loop.poll(link.threadId, signal())).rejects.toMatchObject({ kind: "cli" });
  await loop.poll(link.threadId, signal());
  expect(delivered.map((intent) => intent.headSha)).toEqual([nextSha, nextSha]);
  expect(delivered[1]?.context).toMatchObject({
    type: "review",
    comment: { body: "Current feedback" },
  });
});
it("rejects a paused read across unlink and relink to the identical PR", async () => {
  const { store, runner, executable } = await setup();
  const { GitHubForge } = await import("./index.ts");
  const { promise: ready, resolve: notify } = Promise.withResolvers<void>();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const forge = new GitHubForge({
    repository,
    now: () => 1_000,
    command: executable,
    runner: async (request) => {
      if (request.args[1] === "repos/octo/ace/pulls/7") {
        notify();
        await gate;
      }
      return runner(request);
    },
  });
  const delivered: ForgeAutoFixIntent[] = [];
  const loop = new ReviewLoop({
    forge,
    store,
    executor: {
      async enqueue(intent) {
        delivered.push(intent);
      },
    },
  });
  const pending = loop.poll(link.threadId, signal());
  await ready;
  store.unlink(link.threadId);
  store.link(link);
  release();
  await expect(pending).rejects.toMatchObject({ kind: "conflict" });
  expect(delivered).toEqual([]);
});
