import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SettingsService } from "@ace/settings";
import { ForgePrRef, ProjectRepositoryConfig, SourceControlPreferences } from "@ace/protocol";
import { bitbucketReviewWrites, type CommandRequest, type CommandRunner } from "@ace/forge";
import { Store } from "./store.ts";
import { SourceControl } from "./source-control.ts";
import { ForgeBackends } from "./forge-backends.ts";
import { ForgeReplyReceipts } from "./forge-reply-receipts.ts";
import { WorkspaceForgeReviews } from "./workspace-forge-reviews.ts";
import { readHostedConversation } from "./hosted-review-conversation.ts";
import { reviewBackend } from "./host-routes.ts";

const pr = ForgePrRef.parse({
  repository: { forge: "bitbucket", host: "bitbucket.org", owner: "team", name: "app" },
  number: 7,
});
const head = "a".repeat(40);
const base = "b".repeat(40);
const root = "/2.0/repositories/team/app";
const ok = (body: unknown) => ({ code: 0, truncated: false, stdout: JSON.stringify(body) });

/** bkt as Bitbucket Cloud answers it (developer.atlassian.com/cloud/bitbucket/rest). */
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "ace-bitbucket-reviews-"));
  const settings = new SettingsService({ dataDir: dir });
  const store = new Store(join(dir, "store.sqlite"));
  const seen: CommandRequest[] = [];
  const state = {
    account: "ada",
    /** Whether the comment whose reply was lost is on the pull request. */
    landed: false,
    config: ProjectRepositoryConfig.parse({}),
  };
  const writes = () => seen.filter((r) => r.args[0] === "api" && r.args[3] !== "GET");
  const runner: CommandRunner = async (request) => {
    seen.push(request);
    if (request.command !== "bkt") throw new Error("Wrong CLI");
    if (request.args.join(" ") === "auth status --json")
      return ok({
        hosts: [
          { key: "api.bitbucket.org", kind: "cloud", base_url: "https://api.bitbucket.org/2.0" },
        ],
        contexts: [{ name: "work", host: "api.bitbucket.org", workspace: "team" }],
      });
    const [, endpoint, , method] = request.args;
    const user = { username: state.account, nickname: state.account, uuid: `{${state.account}}` };
    if (method !== "GET") {
      request.dispatch?.prepare?.();
      request.dispatch?.record();
      return { code: 1, truncated: false, stdout: "", unreachable: true as const };
    }
    if (endpoint === "/2.0/user") return ok(user);
    if (endpoint === `${root}/pullrequests/7`)
      return ok({
        id: 7,
        title: "Review",
        state: "OPEN",
        author: { uuid: "{bob}", nickname: "bob" },
        source: {
          branch: { name: "f" },
          commit: { hash: head.slice(0, 12) },
          repository: { full_name: "team/app" },
        },
        destination: { branch: { name: "main" }, commit: { hash: base.slice(0, 12) } },
        participants: [],
      });
    if (endpoint === `${root}/pullrequests/7/commits?pagelen=1`)
      return ok({ values: [{ hash: head }] });
    if (endpoint === `${root}/commit/${base.slice(0, 12)}`) return ok({ hash: base });
    if (endpoint === `${root}/pullrequests/7/comments?pagelen=100`) {
      const sent = writes()[0]?.args[7];
      const raw = sent ? (JSON.parse(sent) as { content: { raw: string } }).content.raw : "";
      return ok({
        values: state.landed
          ? [
              {
                id: 12,
                content: { raw },
                user: { uuid: "{ada}", nickname: "ada" },
                created_on: "2026-11-02",
              },
            ]
          : [],
      });
    }
    return { code: 1, truncated: false, stdout: "", http: { status: 404, headers: {} } };
  };
  const source = new SourceControl(
    settings,
    () => runner,
    dir,
    () => 1000,
  );
  await settings.set(
    "sourceControl.preferences",
    SourceControlPreferences.parse({
      hosts: [{ host: "bitbucket.org", forge: "bitbucket", account: "ada" }],
      host: "bitbucket.org",
      remote: "origin",
    }),
    { kind: "global" },
  );
  const remote = "https://bitbucket.org/team/app.git";
  const git = {
    repositoryInfo: async () => ({
      root: dir,
      branch: "main",
      detached: false,
      head,
      upstream: null,
      ahead: 0,
      behind: 0,
      remotes: [{ name: "origin", fetchUrls: [remote], pushUrls: [remote] }],
    }),
  };
  const backends = new ForgeBackends({
    git,
    now: () => 1000,
    runner: () => runner,
    sourceControl: source,
    replyReceipts: new ForgeReplyReceipts(store),
    signal: new AbortController().signal,
    configs: { forCheckout: () => state.config },
  });
  const workspaceId = store.createWorkspace(dir, "Bitbucket");
  const command = {
    type: "forge.hosted.review",
    workspaceId,
    pr,
    action: { kind: "conversation", body: "hello" },
  };
  return {
    dir,
    store,
    source,
    state,
    seen,
    writes,
    backends,
    command,
    workspaceId,
    signal: new AbortController().signal,
    close: async () => {
      source.close();
      await settings.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("a hidden Bitbucket repository is refused before bkt runs at all", async () => {
  const f = await setup();
  try {
    f.state.config = ProjectRepositoryConfig.parse({ hidden: [pr.repository] });
    await expect(reviewBackend(f.backends, f.dir, pr, f.signal)).rejects.toThrow(
      "repository_hidden",
    );
    expect(f.seen).toEqual([]);
  } finally {
    await f.close();
  }
});

test("an account switch after admission refuses a Bitbucket comment before sending it", async () => {
  const f = await setup();
  try {
    const backend = await reviewBackend(f.backends, f.dir, pr, f.signal);
    f.state.account = "grace";
    await expect(
      new WorkspaceForgeReviews(f.store).execute(
        f.command,
        "switch",
        backend,
        f.signal,
        () => true,
      ),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect(f.writes()).toEqual([]);
  } finally {
    await f.close();
  }
});

test("the Bitbucket write runner refuses a merge, which it never admits", async () => {
  const f = await setup();
  try {
    const identity = await f.source.writeIdentity(
      f.dir,
      pr.repository,
      bitbucketReviewWrites(pr.repository, 7),
      f.signal,
    );
    const merge = identity.runner({
      command: "bkt",
      args: [
        "api",
        `${root}/pullrequests/7/merge`,
        "--method",
        "POST",
        "--context",
        "work",
        "--input",
        "{}",
      ],
      mode: "json",
      signal: f.signal,
    });
    await expect(merge).rejects.toMatchObject({ kind: "unsupported" });
    expect(f.writes()).toEqual([]);
  } finally {
    await f.close();
  }
});

test("an uncertain Bitbucket comment stays uncertain, blocks a retry, and reconciles without reposting", async () => {
  const f = await setup();
  try {
    const backend = await reviewBackend(f.backends, f.dir, pr, f.signal);
    const journal = new WorkspaceForgeReviews(f.store);
    await expect(journal.execute(f.command, "lost", backend, f.signal, () => true)).rejects.toThrow(
      "action_outcome_uncertain",
    );
    const read = () =>
      readHostedConversation(
        f.backends,
        journal,
        f.dir,
        pr,
        { op: "forge.pr.review-state", workspaceId: f.workspaceId, number: 7 },
        f.signal,
      );
    expect(await read()).toMatchObject({
      resource: "prReviewState",
      value: { operations: [{ id: "lost", state: "uncertain" }], headSha: head },
    });
    await expect(
      journal.execute(f.command, "retry", backend, f.signal, () => true),
    ).rejects.toThrow("action_outcome_uncertain");
    f.state.landed = true;
    await journal.execute(
      { ...f.command, action: { kind: "reconcile", operationId: "lost" } },
      "reconcile",
      backend,
      f.signal,
      () => true,
    );
    expect(await read()).toMatchObject({
      resource: "prReviewState",
      value: { operations: [{ id: "lost", state: "accepted" }] },
    });
    expect(f.writes()).toHaveLength(1);
  } finally {
    await f.close();
  }
});
