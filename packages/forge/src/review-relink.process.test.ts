import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import type { ForgeAutoFixIntent } from "@ace/protocol/forge";
import { ForgeStore, ReviewLoop, GitHubForge } from "./index.ts";
import { fakeGh, standard, sha, comment, repository, threads } from "./testing/fixtures.ts";

it("rejects a paused feedback-free read across identical unlink and relink", async () => {
  const fixtures = standard();
  fixtures[`repos/octo/ace/commits/${sha}/check-runs?per_page=100&filter=latest`] = [
    { body: { check_runs: [] } },
  ];
  fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [{ body: [] }];
  fixtures.graphql = [{ body: threads() }];
  const fake = await fakeGh(fixtures);
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ForgeStore(db);
    const link = { threadId: "empty", pr: { repository, number: 7 } };
    store.link(link);
    const ready = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const forge = new GitHubForge({
      repository,
      command: fake.executable,
      now: () => 1000,
      runner: async (request) => {
        if (request.args[1] === "repos/octo/ace/pulls/7") {
          ready.resolve();
          await gate.promise;
        }
        return fake.runner(request);
      },
    });
    const accepted: ForgeAutoFixIntent[] = [];
    const loop = new ReviewLoop({
      forge,
      store,
      executor: {
        async enqueue(intent) {
          accepted.push(intent);
        },
      },
    });
    const pending = loop.poll("empty", new AbortController().signal);
    await ready.promise;
    store.unlink("empty");
    store.link(link);
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ kind: "conflict" });
    expect(accepted).toEqual([]);
  } finally {
    db.close();
    await fake.cleanup();
  }
});

it("queues location-only edited feedback with fresh file and line context", async () => {
  const fixtures = standard();
  fixtures[`repos/octo/ace/commits/${sha}/check-runs?per_page=100&filter=latest`] = [
    { body: { check_runs: [] } },
  ];
  fixtures.graphql = [{ body: threads() }];
  fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [
    { body: [comment] },
    { body: [{ ...comment, path: "src/other.ts", line: 29 }] },
  ];
  const fake = await fakeGh(fixtures);
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ForgeStore(db);
    store.link({ threadId: "location", pr: { repository, number: 7 } });
    const accepted: ForgeAutoFixIntent[] = [];
    const loop = new ReviewLoop({
      forge: fake.forge,
      store,
      executor: {
        async enqueue(intent) {
          accepted.push(intent);
        },
      },
    });
    await loop.poll("location", new AbortController().signal);
    await loop.poll("location", new AbortController().signal);
    expect(accepted.map((intent) => intent.context)).toMatchObject([
      { type: "review", comment: { file: comment.path, line: comment.line } },
      { type: "review", comment: { file: "src/other.ts", line: 29 } },
    ]);
  } finally {
    db.close();
    await fake.cleanup();
  }
});
