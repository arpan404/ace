import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore, ReviewLoop, watchPr, mapPr, ReviewIndex } from "./index.ts";
import type { ForgeAutoFixIntent } from "@ace/protocol/forge";
import {
  fakeGh,
  standard,
  repository,
  pr,
  sha,
  check,
  comment,
  threads,
  thread,
  nextSha,
} from "./testing/fixtures.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
const signal = () => new AbortController().signal;
const link = { threadId: "thread-1", pr: { repository, number: 7 } };
async function setup(fixtures = standard()) {
  const fake = await fakeGh(fixtures);
  cleanups.push(fake.cleanup);
  const db = new DatabaseSync(join(fake.dir, "forge.db"));
  cleanups.push(async () => {
    db.close();
  });
  const store = new ForgeStore(db);
  store.link(link);
  return { ...fake, db, store };
}

describe("durable review loop", () => {
  it("queues failing job context and file/line review context once across restarts", async () => {
    const fixtures = standard();
    fixtures["repos/octo/ace/actions/jobs/99/logs"] = [
      { repeat: 10_000, text: "log\n", suffix: "final failure\n" },
    ];
    const { forge, store, dir } = await setup(fixtures);
    const delivered: ForgeAutoFixIntent[] = [];
    const executor = {
      async enqueue(intent: ForgeAutoFixIntent) {
        delivered.push(intent);
      },
    };
    await new ReviewLoop({ forge, store, executor }).poll(link.threadId, signal());
    expect(delivered).toHaveLength(2);
    expect(delivered[0]?.context).toMatchObject({
      type: "ci",
      check: { name: "test", jobId: 99 },
      truncated: true,
      logUnavailable: false,
    });
    if (delivered[0]?.context.type === "ci") {
      expect(Buffer.byteLength(delivered[0].context.logTail)).toBeLessThanOrEqual(16_384);
      expect(delivered[0].context.logTail.endsWith("final failure\n")).toBe(true);
    }
    expect(delivered[1]?.context).toMatchObject({
      type: "review",
      comment: { body: "Handle empty input", file: "src/main.ts", line: 12 },
    });
    const restartedDb = new DatabaseSync(join(dir, "forge.db"));
    try {
      const restarted = new ForgeStore(restartedDb);
      expect(restarted.getLink(link.threadId)).toEqual(link);
      await new ReviewLoop({ forge, store: restarted, executor }).poll(link.threadId, signal());
      expect(delivered).toHaveLength(2);
    } finally {
      restartedDb.close();
    }
  });
  it("retries after executor rejection without duplicating accepted work", async () => {
    const { forge, store } = await setup();
    const accepted = new Map<string, ForgeAutoFixIntent>();
    let reject = true;
    const executor = {
      async enqueue(intent: ForgeAutoFixIntent) {
        accepted.set(intent.key, intent);
        if (reject) {
          reject = false;
          throw new Error("simulated crash after durable enqueue");
        }
      },
    };
    const loop = new ReviewLoop({ forge, store, executor });
    await expect(loop.poll(link.threadId, signal())).rejects.toMatchObject({ kind: "cli" });
    expect(store.pending(link.threadId)).toHaveLength(2);
    await loop.poll(link.threadId, signal());
    expect([...accepted.values()].map((intent) => intent.context.type)).toEqual(["ci", "review"]);
    expect(store.pending(link.threadId)).toEqual([]);
  });
  it("queues edited and new comments, and a fresh failing check on a new commit", async () => {
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
      {
        body: [
          { ...comment, body: "Also handle null", updated_at: "later" },
          { ...comment, id: 14, body: "new comment" },
        ],
      },
    ];
    const { forge, store } = await setup(fixtures);
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
    await loop.poll(link.threadId, signal());
    await loop.poll(link.threadId, signal());
    expect(delivered).toHaveLength(5);
    expect(delivered[2]).toMatchObject({ headSha: nextSha, context: { type: "ci" } });
    expect(
      delivered
        .slice(3)
        .map((intent) => (intent.context.type === "review" ? intent.context.comment.body : "")),
    ).toEqual(["Also handle null", "new comment"]);
  });
  it("ignores resolved and outdated threads and caller-specified authors", async () => {
    const fixtures = standard();
    fixtures.graphql = [
      { body: threads([thread(true)]) },
      { body: threads([thread(false, true)]) },
      { body: threads([thread()]) },
    ];
    const { forge, store } = await setup(fixtures);
    const intents: ForgeAutoFixIntent[] = [];
    const loop = new ReviewLoop({
      forge,
      store,
      ignoredAuthors: ["reviewer"],
      executor: {
        async enqueue(intent) {
          intents.push(intent);
        },
      },
    });
    await loop.poll(link.threadId, signal());
    await loop.poll(link.threadId, signal());
    await loop.poll(link.threadId, signal());
    expect(intents.map((intent) => intent.context.type)).toEqual(["ci"]);
    const status = mapPr(link.pr, pr, []);
    status.comments = [
      {
        kind: "inline",
        id: 13,
        body: "review",
        author: "reviewer",
        file: "x",
        line: 1,
        updatedAt: "now",
        replyTo: null,
      },
    ];
    status.reviewThreads = [
      { id: "t", resolved: true, outdated: false, file: "x", line: 1, comments: status.comments },
    ];
    const index = new ReviewIndex({ link, generation: 1 }, new Set());
    index.update(status);
    expect([...index.pending()]).toEqual([]);
    status.reviewThreads = [
      {
        id: "t",
        resolved: false,
        outdated: true,
        file: "x",
        line: 1,
        comments: status.comments,
      },
    ];
    index.update({ ...status });
    expect([...index.pending()]).toEqual([]);
  });
  it("delivers a failing external check even when no job logs are available", async () => {
    const fixtures = standard();
    fixtures["repos/octo/ace/actions/jobs/99/logs"] = [
      { status: 403, raw: "Authorization: ghp_secret" },
    ];
    const { forge, store } = await setup(fixtures);
    const intents: ForgeAutoFixIntent[] = [];
    await new ReviewLoop({
      forge,
      store,
      executor: {
        async enqueue(intent) {
          intents.push(intent);
        },
      },
    }).poll(link.threadId, signal());
    expect(intents[0]?.context).toMatchObject({ type: "ci", logTail: "", logUnavailable: true });
    expect(JSON.stringify(intents)).not.toContain("ghp_secret");
  });
  it("redacts secrets before they enter snapshots, events or persisted intents", async () => {
    const fixtures = standard();
    fixtures["repos/octo/ace/pulls/7"] = [
      { body: { ...pr, title: "ghp_privateToken", auth_token: "opaque-secret" } },
    ];
    fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [
      { body: [{ ...comment, body: "Bearer opaque-secret and github_pat_private123" }] },
    ];
    fixtures.graphql = [{ body: threads() }];
    fixtures["repos/octo/ace/actions/jobs/99/logs"] = [
      { raw: "GH_TOKEN=opaque-secret\nghp_privateToken\n" },
    ];
    const { forge, store, db } = await setup(fixtures);
    const events: unknown[] = [];
    const loop = new ReviewLoop({
      forge,
      store,
      executor: {
        async enqueue(intent) {
          events.push({ type: "forge.auto-fix.queued", intent });
        },
      },
    });
    const status = await loop.poll(link.threadId, signal());
    events.push({ type: "forge.pr.updated", status });
    const output = JSON.stringify(events);
    expect(output).not.toContain("privateToken");
    expect(output).not.toContain("opaque-secret");
    expect(output).not.toContain("private123");
    expect(JSON.stringify(db.prepare("SELECT * FROM forge_intents").all())).not.toContain(
      "privateToken",
    );
  });
  it("bounds pending work and deletes links and delivery identities on unlink", async () => {
    const { store, db } = await setup();
    const tiny = new ForgeStore(db, 1);
    const intent: ForgeAutoFixIntent = {
      type: "auto-fix",
      key: "one",
      linkGeneration: 1,
      link,
      headSha: sha,
      context: {
        type: "review",
        comment: {
          kind: "inline",
          id: 1,
          body: "fix",
          author: "user",
          file: null,
          line: null,
          updatedAt: "now",
          replyTo: null,
        },
      },
    };
    tiny.admit(intent);
    expect(() => tiny.admit({ ...intent, key: "two" })).toThrow("limit");
    tiny.acknowledge(intent);
    tiny.admit({ ...intent, key: "two" });
    expect(tiny.hasIntent(link.threadId, "one")).toBe(true);
    store.unlink(link.threadId);
    expect(store.getLink(link.threadId)).toBeUndefined();
    expect(store.pending(link.threadId)).toEqual([]);
    expect(store.hasIntent(link.threadId, "one")).toBe(false);
    store.link(link);
    expect(() => tiny.admit(intent)).toThrow("conflict");
    tiny.admit({ ...intent, linkGeneration: 2 });
    expect(tiny.pending(link.threadId)[0]?.context).toMatchObject({ type: "review" });
  });
  it("queues general feedback even when an inline comment has the same numeric ID", async () => {
    const fixtures = standard();
    fixtures["repos/octo/ace/issues/7/comments?per_page=100"] = [
      { body: [{ ...comment, body: "General feedback" }] },
    ];
    fixtures.graphql = [{ body: threads([thread(true)]) }];
    const { forge, store } = await setup(fixtures);
    const intents: ForgeAutoFixIntent[] = [];
    await new ReviewLoop({
      forge,
      store,
      executor: {
        async enqueue(intent) {
          intents.push(intent);
        },
      },
    }).poll(link.threadId, signal());
    expect(
      intents.filter((intent) => intent.context.type === "review").map((intent) => intent.context),
    ).toEqual([
      {
        type: "review",
        comment: {
          kind: "issue",
          id: 13,
          body: "General feedback",
          author: "reviewer",
          file: "src/main.ts",
          line: 12,
          updatedAt: comment.updated_at,
          replyTo: null,
        },
      },
    ]);
  });

  it("rejects overlapping polls and does not deliver work after the link is removed", async () => {
    const { runner, executable, store } = await setup();
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
    const first = loop.poll(link.threadId, signal());
    await ready;
    await expect(loop.poll(link.threadId, signal())).rejects.toMatchObject({ kind: "conflict" });
    store.unlink(link.threadId);
    release();
    await expect(first).rejects.toMatchObject({ kind: "conflict" });
    expect(intents).toEqual([]);
  });

  it("polls serially with rate-limit backoff and stops after merge", async () => {
    const { forge, store } = await setup();
    const loop = new ReviewLoop({ forge, store, executor: { async enqueue() {} } });
    const open = await loop.poll(link.threadId, signal());
    let count = 0;
    const waits: number[] = [];
    const states: string[] = [];
    const errors: string[] = [];
    const { ForgeError } = await import("./index.ts");
    await watchPr({
      loop: {
        async poll() {
          count++;
          if (count === 1) throw new ForgeError("rate_limit", 121_000);
          return { ...open, state: count === 2 ? "open" : "merged" };
        },
      },
      threadId: link.threadId,
      signal: signal(),
      now: () => 1_000,
      async wait(ms) {
        waits.push(ms);
      },
      async onStatus(status) {
        states.push(status.state);
      },
      onError(kind) {
        errors.push(kind);
      },
    });
    expect(waits).toEqual([120_000, 15_000]);
    expect(states).toEqual(["open", "merged"]);
    expect(errors).toEqual(["rate_limit"]);
  });
});
