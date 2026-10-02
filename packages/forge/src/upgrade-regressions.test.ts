import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ForgeAutoFixIntent } from "@ace/protocol/forge";
import { ForgeStore, ReviewLoop, GitHubForge, ReviewIndex } from "./index.ts";
import { fakeGh, standard, sha, comment, repository, threads } from "./testing/fixtures.ts";

it("preserves acknowledged pre-generation feedback across file SQLite upgrade and later location edits", async () => {
  const fixtures = standard();
  fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [
    { body: [comment] },
    { body: [{ ...comment, path: "src/other.ts", line: 29 }] },
  ];
  fixtures.graphql = [{ body: threads() }];
  const fake = await fakeGh(fixtures);
  const path = join(fake.dir, "legacy.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(await readFile(new URL("./testing/legacy-ledger.sql", import.meta.url), "utf8"));
  legacy.close();
  const db = new DatabaseSync(path);
  try {
    const accepted: ForgeAutoFixIntent[] = [];
    const store = new ForgeStore(db);
    const loop = new ReviewLoop({
      forge: fake.forge,
      store,
      executor: {
        async enqueue(intent) {
          accepted.push(intent);
        },
      },
    });
    await loop.poll("upgrade", new AbortController().signal);
    expect(accepted).toEqual([]);
    await loop.poll("upgrade", new AbortController().signal);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.context).toMatchObject({
      type: "review",
      comment: { file: "src/other.ts", line: 29 },
    });
  } finally {
    db.close();
    await fake.cleanup();
  }
});

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

it("retries unacknowledged legacy delivery with the original executor identity after upgrade", async () => {
  const fake = await fakeGh(standard());
  const path = join(fake.dir, "pending-upgrade.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec(
      await readFile(new URL("./testing/legacy-pending-ledger.sql", import.meta.url), "utf8"),
    );
    const legacyKey =
      "forge:5182cd66016cd28ef7b4f1286499e1ccca7d05077e1df95498ae687cb444de0b:ci:f4f9274aeb9094ef1b9a1bb3e2f14269a0187d49aafd1208adb615571551f7e1";
    const accepted = new Set([legacyKey]);
    const retried: string[] = [];
    const fresh: ForgeAutoFixIntent[] = [];
    const loop = new ReviewLoop({
      forge: fake.forge,
      store: new ForgeStore(db),
      executor: {
        async enqueue(intent) {
          if (accepted.has(intent.key)) retried.push(intent.key);
          else {
            accepted.add(intent.key);
            fresh.push(intent);
          }
        },
      },
    });
    await loop.poll("upgrade", new AbortController().signal);
    await loop.poll("upgrade", new AbortController().signal);
    expect(fresh).toEqual([]);
    expect(retried).toEqual([legacyKey]);
  } finally {
    db.close();
    await fake.cleanup();
  }
});

it.each([
  { change: "file", file: "src/other.ts", line: comment.line },
  { change: "line", file: comment.path, line: 29 },
  { change: "file and line", file: "src/other.ts", line: 29 },
])(
  "replaces a legacy pending review after a $change edit with only current context",
  async ({ file, line }) => {
    const fixtures = standard();
    fixtures[`repos/octo/ace/commits/${sha}/check-runs?per_page=100&filter=latest`] = [
      { body: { check_runs: [] } },
    ];
    fixtures.graphql = [{ body: threads() }];
    fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [
      { body: [{ ...comment, path: file, line }] },
    ];
    const fake = await fakeGh(fixtures);
    const path = join(fake.dir, "pending-review-upgrade.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(
      await readFile(
        new URL("./testing/legacy-review-pending-ledger.sql", import.meta.url),
        "utf8",
      ),
    );
    legacy.close();
    const db = new DatabaseSync(path);
    try {
      const store = new ForgeStore(db);
      const oldKey =
        "forge:5182cd66016cd28ef7b4f1286499e1ccca7d05077e1df95498ae687cb444de0b:comment:inline:13:48292f9b86d5cca5501054de226fbe0e59f9314abd4d6dfa0395abc14b0024fb";
      const pending = store.pending("upgrade");
      expect(pending.map((intent) => intent.key)).toEqual([oldKey]);
      expect(pending.map((intent) => intent.context)).toEqual([
        {
          type: "review",
          comment: {
            kind: "inline",
            id: comment.id,
            body: comment.body,
            author: comment.user.login,
            file: comment.path,
            line: comment.line,
            updatedAt: comment.updated_at,
            replyTo: null,
          },
        },
      ]);
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
      await loop.poll("upgrade", new AbortController().signal);
      expect(accepted.map((intent) => intent.context)).toEqual([
        {
          type: "review",
          comment: {
            kind: "inline",
            id: comment.id,
            body: comment.body,
            author: comment.user.login,
            file,
            line,
            updatedAt: comment.updated_at,
            replyTo: null,
          },
        },
      ]);
      expect(accepted[0]?.key).not.toBe(oldKey);
      expect(store.pending("upgrade")).toEqual([]);
      await loop.poll("upgrade", new AbortController().signal);
      expect(accepted).toHaveLength(1);
    } finally {
      db.close();
      await fake.cleanup();
    }
  },
);

it.each(["acknowledged", "pending"])(
  "adopts legacy acceptance when a %s modern identity already exists",
  async (state) => {
    const fixtures = standard();
    fixtures.graphql = [{ body: threads() }];
    fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [
      { body: [comment] },
      { body: [comment] },
      { body: [{ ...comment, path: "src/other.ts", line: 29 }] },
    ];
    const fake = await fakeGh(fixtures);
    const db = new DatabaseSync(join(fake.dir, "mixed.sqlite"));
    try {
      db.exec(await readFile(new URL("./testing/legacy-ledger.sql", import.meta.url), "utf8"));
      const store = new ForgeStore(db);
      const linkState = store.getLinkState("upgrade");
      if (!linkState) throw new Error("Missing legacy link");
      const snapshot = await fake.forge.status(7, new AbortController().signal);
      const index = new ReviewIndex(linkState, new Set(), fake.forge.revisions);
      index.update(snapshot);
      for (const candidate of index.pending()) {
        const intent: ForgeAutoFixIntent = {
          type: "auto-fix",
          key: candidate.key,
          link: linkState.link,
          linkGeneration: 1,
          headSha: snapshot.headSha,
          context:
            candidate.type === "review"
              ? { type: "review", comment: candidate.comment }
              : {
                  type: "ci",
                  check: candidate.check,
                  logTail: "",
                  truncated: false,
                  logUnavailable: false,
                },
        };
        store.admit(intent);
        if (state === "acknowledged") store.acknowledge(intent);
      }
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
      await loop.poll("upgrade", new AbortController().signal);
      expect(accepted).toEqual([]);
      await loop.poll("upgrade", new AbortController().signal);
      expect(accepted).toHaveLength(1);
      expect(accepted[0]?.context).toMatchObject({
        type: "review",
        comment: { file: "src/other.ts", line: 29 },
      });
    } finally {
      db.close();
      await fake.cleanup();
    }
  },
);
