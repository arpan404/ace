import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ForgeStore, ReviewLoop } from "./index.ts";
import type { ForgeAutoFixIntent } from "@ace/protocol/forge";
import {
  fakeGh,
  standard,
  repository,
  pr,
  sha,
  nextSha,
  threads,
  comment,
} from "./testing/fixtures.ts";
const actions: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of actions.splice(0).toReversed()) await action();
});
const link = { threadId: "retry", pr: { repository, number: 7 } };
const signal = () => new AbortController().signal;
async function setup(fixtures = standard(), cap = 2_000) {
  const fake = await fakeGh(fixtures);
  actions.push(fake.cleanup);
  const path = join(fake.dir, "retry.sqlite");
  const db = new DatabaseSync(path);
  actions.push(async () => {
    db.close();
  });
  const store = new ForgeStore(db, cap);
  store.link(link);
  return { ...fake, store, path };
}
it("preserves unadmitted feedback under backpressure until a later unchanged poll", async () => {
  const { forge, store } = await setup(standard(), 1);
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
  await expect(loop.poll(link.threadId, signal())).rejects.toMatchObject({ kind: "limit" });
  await loop.poll(link.threadId, signal());
  expect(delivered.map((intent) => intent.context.type)).toEqual(["ci", "review"]);
  expect(store.pending(link.threadId)).toEqual([]);
});
it("rebinds unaccepted unchanged review text to the current head before retrying", async () => {
  const fixtures = standard();
  fixtures["repos/octo/ace/pulls/7"] = [
    { body: pr },
    { body: { ...pr, head: { ...pr.head, sha: nextSha } } },
  ];
  for (const head of [sha, nextSha]) {
    fixtures[`repos/octo/ace/commits/${head}/check-runs?per_page=100&filter=latest`] = [
      { body: { check_runs: [] } },
    ];
    fixtures[`repos/octo/ace/commits/${head}/statuses?per_page=100`] = [{ body: [] }];
  }
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
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({
    headSha: nextSha,
    context: { type: "review", comment: { body: comment.body } },
  });
});
it("persists link generations across reopen and gives relinked feedback fresh executor identities", async () => {
  const { forge, store, path } = await setup();
  const accepted = new Map<string, ForgeAutoFixIntent>();
  const loop = new ReviewLoop({
    forge,
    store,
    executor: {
      async enqueue(intent) {
        accepted.set(intent.key, intent);
      },
    },
  });
  await loop.poll(link.threadId, signal());
  store.unlink(link.threadId);
  store.link(link);
  const reopened = new DatabaseSync(path);
  try {
    expect(new ForgeStore(reopened).getLinkState(link.threadId)).toMatchObject({
      link,
      generation: 2,
    });
  } finally {
    reopened.close();
  }
  await loop.poll(link.threadId, signal());
  expect([...accepted.values()].map((intent) => intent.linkGeneration)).toEqual([1, 1, 2, 2]);
});
it("withdraws an unaccepted review summary after it is dismissed", async () => {
  const fixtures = standard();
  fixtures[`repos/octo/ace/commits/${sha}/check-runs?per_page=100&filter=latest`] = [
    { body: { check_runs: [] } },
  ];
  fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [{ body: [] }];
  fixtures.graphql = [{ body: threads() }];
  const review = {
    id: 1,
    body: "Fix this",
    state: "CHANGES_REQUESTED",
    user: { login: "alice" },
    submitted_at: "now",
  };
  fixtures["repos/octo/ace/pulls/7/reviews?per_page=100"] = [
    { body: [review] },
    { body: [{ ...review, state: "DISMISSED" }] },
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
});
it("rejects overlap by result without relying on a timer or removing the link", async () => {
  const { store, runner, executable } = await setup();
  const { GitHubForge } = await import("./index.ts");
  const { promise: ready, resolve: notify } = Promise.withResolvers<void>();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const forge = new GitHubForge({
    repository,
    command: executable,
    now: () => 1_000,
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
  const first = loop.poll(link.threadId, signal());
  await ready;
  const second = loop.poll(link.threadId, signal()).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  release();
  await first;
  expect((await second).error).toMatchObject({ kind: "conflict" });
  expect(delivered.map((intent) => intent.context.type)).toEqual(["ci", "review"]);
});
it("publishes only changed immutable PR revisions during watching", async () => {
  const fixtures = standard();
  fixtures["repos/octo/ace/pulls/7"] = [
    { body: pr, headers: { ETag: '"pr"' } },
    { status: 304, raw: "" },
    { body: { ...pr, merged: true, state: "closed" } },
  ];
  const { forge, store } = await setup(fixtures);
  const { watchPr } = await import("./index.ts");
  const states: string[] = [];
  await watchPr({
    loop: new ReviewLoop({ forge, store, executor: { async enqueue() {} } }),
    threadId: link.threadId,
    signal: signal(),
    now: () => 1_000,
    async wait() {},
    async onStatus(status) {
      states.push(status.state);
    },
    onError(kind) {
      throw new Error(kind);
    },
  });
  expect(states).toEqual(["open", "merged"]);
});
