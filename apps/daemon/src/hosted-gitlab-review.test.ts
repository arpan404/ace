import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SettingsService } from "@ace/settings";
import {
  ForgePrRef,
  Thread,
  ProjectRepositoryConfig,
  SourceControlPreferences,
} from "@ace/protocol";
import { ForgeStore, type CommandRequest, type CommandRunner, reviewWriteMarker } from "@ace/forge";
import { Store } from "./store.ts";
import { SourceControl } from "./source-control.ts";
import { ForgeBackends } from "./forge-backends.ts";
import { ForgeReplyReceipts } from "./forge-reply-receipts.ts";
import { WorkspaceForge } from "./workspace-forge.ts";
import { WorkspaceForgeReviews } from "./workspace-forge-reviews.ts";
import { gitLabReviewBackend, readHostedConversation } from "./hosted-review-conversation.ts";
const pr = ForgePrRef.parse({
  repository: { forge: "gitlab", host: "gitlab.com", owner: "acme", name: "ace" },
  number: 7,
});
const head = "a".repeat(40);
const mr = {
  iid: 7,
  title: "Review",
  state: "opened",
  updated_at: "2026-01-01T00:00:00Z",
  sha: head,
  diff_refs: { base_sha: "b".repeat(40), start_sha: "c".repeat(40), head_sha: head },
  reviewers: [],
  author: { username: "bob" },
};
const http = (body: unknown) => ({
  code: 0,
  truncated: false,
  stdout: `HTTP/2.0 200 OK\r\nx-next-page: \r\n\r\n${JSON.stringify(body)}`,
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "ace-gitlab-reviews-"));
  const settings = new SettingsService({ dataDir: root });
  const store = new Store(join(root, "store.sqlite"));
  const seen: CommandRequest[] = [];
  const state = {
    account: "alice",
    visible: false,
    uncertain: true,
    config: ProjectRepositoryConfig.parse({}),
    onDiscussions: undefined as (() => void) | undefined,
  };
  const runner: CommandRunner = async (request) => {
    seen.push(request);
    if (request.command !== "glab") throw new Error("Wrong CLI");
    const endpoint = request.args[1] ?? "";
    if (endpoint === "user") return http({ id: 42, username: state.account });
    if (endpoint.startsWith("users?")) return http([{ id: 99, username: "reviewer.name" }]);
    if (request.input) {
      request.dispatch?.prepare?.();
      request.dispatch?.record();
      if (state.uncertain) return { code: 1, truncated: false, stdout: "", unreachable: true };
      if (request.args[3] === "PUT") return http(mr);
      return http({
        id: 12,
        body: "hello",
        author: { id: 42, username: state.account },
        system: false,
        created_at: mr.updated_at,
        updated_at: mr.updated_at,
      });
    }
    if (endpoint.includes("/discussions?")) state.onDiscussions?.();
    if (endpoint.includes("/discussions?"))
      return http(
        state.visible
          ? [
              {
                id: "abcdef",
                individual_note: true,
                notes: [
                  {
                    id: 12,
                    body: `hello\n\n${reviewWriteMarker("lost")}`,
                    author: { id: 42, username: "alice" },
                    system: false,
                    created_at: mr.updated_at,
                    updated_at: mr.updated_at,
                  },
                ],
              },
            ]
          : [],
      );
    return http(mr);
  };
  const source = new SourceControl(
    settings,
    () => runner,
    root,
    () => 1000,
  );
  await settings.set(
    "sourceControl.preferences",
    SourceControlPreferences.parse({
      hosts: [{ host: "gitlab.com", forge: "gitlab", account: "alice" }],
      host: "gitlab.com",
      remote: "origin",
    }),
    { kind: "global" },
  );
  const git = {
    repositoryInfo: async () => ({
      root,
      branch: "main",
      detached: false,
      head,
      upstream: null,
      ahead: 0,
      behind: 0,
      remotes: [
        {
          name: "origin",
          fetchUrls: ["https://gitlab.com/acme/ace.git"],
          pushUrls: ["https://gitlab.com/acme/ace.git"],
        },
      ],
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
  const workspaceId = store.createWorkspace(root, "GitLab");
  const command = {
    type: "forge.hosted.review",
    workspaceId,
    pr,
    action: { kind: "conversation", body: "hello" },
  };
  const signal = new AbortController().signal;
  return {
    root,
    store,
    source,
    git,
    runner,
    state,
    seen,
    backends,
    command,
    signal,
    workspaceId,
    close: async () => {
      source.close();
      await settings.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("hidden repositories are refused before GitLab identity or write dispatch", async () => {
  const f = await setup();
  try {
    f.state.config = ProjectRepositoryConfig.parse({ hidden: [pr.repository] });
    await expect(gitLabReviewBackend(f.backends, f.root, pr, f.signal)).rejects.toThrow(
      "repository_hidden",
    );
    expect(f.seen).toEqual([]);
    const unavailable = { ...pr, repository: { ...pr.repository, host: "unconfigured.example" } };
    f.state.config = ProjectRepositoryConfig.parse({ added: [unavailable.repository] });
    await expect(gitLabReviewBackend(f.backends, f.root, unavailable, f.signal)).rejects.toThrow(
      "repository_unavailable",
    );
    expect(f.seen).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a durable uncertain GitLab comment survives journal restart and reconciles without reposting", async () => {
  const f = await setup();
  try {
    const backend = await gitLabReviewBackend(f.backends, f.root, pr, f.signal);
    await expect(
      new WorkspaceForgeReviews(f.store).execute(f.command, "lost", backend, f.signal, () => true),
    ).rejects.toThrow("action_outcome_uncertain");
    const journal = new WorkspaceForgeReviews(f.store);
    const before = await readHostedConversation(
      f.backends,
      journal,
      f.root,
      pr,
      { op: "forge.pr.review-state", workspaceId: f.workspaceId, number: 7 },
      f.signal,
    );
    expect(before).toMatchObject({
      resource: "prReviewState",
      value: { operations: [{ id: "lost", state: "uncertain" }], headSha: head },
    });
    await expect(
      journal.execute(f.command, "retry", backend, f.signal, () => true),
    ).rejects.toThrow("action_outcome_uncertain");
    f.state.visible = true;
    await journal.execute(
      { ...f.command, action: { kind: "reconcile", operationId: "lost" } },
      "reconcile",
      backend,
      f.signal,
      () => true,
    );
    const after = await readHostedConversation(
      f.backends,
      journal,
      f.root,
      pr,
      { op: "forge.pr.review-state", workspaceId: f.workspaceId, number: 7 },
      f.signal,
    );
    expect(after).toMatchObject({
      resource: "prReviewState",
      value: { operations: [{ id: "lost", state: "accepted" }] },
    });
    expect(f.seen.filter((r) => r.input !== undefined)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("an account switch after admission refuses a GitLab comment before sending it", async () => {
  const f = await setup();
  try {
    const backend = await gitLabReviewBackend(f.backends, f.root, pr, f.signal);
    f.state.account = "other";
    await expect(
      new WorkspaceForgeReviews(f.store).execute(
        f.command,
        "switch",
        backend,
        f.signal,
        () => true,
      ),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect(f.seen.filter((r) => r.input)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("thread reply and reviewer commands route through the GitLab journal", async () => {
  const f = await setup();
  const forge = new WorkspaceForge(
    f.store,
    f.git,
    () => 1000,
    () => f.runner,
    f.source,
  );
  try {
    const thread = Thread.parse({
      id: "thread",
      workspaceId: f.workspaceId,
      title: "Review",
      provider: "codex",
      status: { state: "new" },
      createdAt: 1,
      updatedAt: 1,
    });
    f.store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
    f.state.visible = true;
    f.state.uncertain = false;
    const link = { threadId: thread.id, pr };
    expect(
      await forge.execute(
        { type: "forge.comment.reply", link, commentId: 12, body: "reply" },
        f.root,
        () => true,
        "thread-reply",
      ),
    ).toMatchObject({ ok: true });
    expect(
      await forge.execute(
        { type: "forge.review.request", link, reviewers: ["reviewer.name"] },
        f.root,
        () => true,
        "thread-reviewers",
      ),
    ).toMatchObject({ ok: true });
    const writes = f.seen.filter((r) => r.input);
    expect(writes.map((w) => w.args[1])).toEqual([
      "projects/acme%2Face/merge_requests/7/discussions/abcdef/notes",
      "projects/acme%2Face/merge_requests/7",
    ]);
    expect(JSON.parse(writes[1]?.input ?? "null")).toEqual({ reviewer_ids: [99] });
    expect(
      await forge.browse(
        f.root,
        {
          op: "forge.pr.review-state",
          workspaceId: f.workspaceId,
          repository: pr.repository,
          number: 7,
        },
        f.signal,
      ),
    ).toMatchObject({
      resource: "prReviewState",
      value: {
        operations: [
          { id: "thread-reviewers", state: "accepted" },
          { id: "thread-reply", state: "accepted" },
        ],
      },
    });
  } finally {
    forge.close();
    await f.close();
  }
});

test("relinking a thread while its GitLab reply is in flight sends nothing", async () => {
  const f = await setup();
  const forge = new WorkspaceForge(
    f.store,
    f.git,
    () => 1000,
    () => f.runner,
    f.source,
  );
  try {
    const thread = Thread.parse({
      id: "relinked",
      workspaceId: f.workspaceId,
      title: "Review",
      provider: "codex",
      status: { state: "new" },
      createdAt: 1,
      updatedAt: 1,
    });
    f.store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
    const links = f.store.atomic((db) => new ForgeStore(db));
    links.link({ threadId: thread.id, pr });
    f.state.visible = true;
    f.state.uncertain = false;
    f.state.onDiscussions = () => {
      f.state.onDiscussions = undefined;
      links.unlink(thread.id, pr);
      links.link({ threadId: thread.id, pr });
    };
    await expect(
      forge.execute(
        {
          type: "forge.comment.reply",
          link: { threadId: thread.id, pr },
          commentId: 12,
          body: "r",
        },
        f.root,
        () => true,
        "relinked-reply",
      ),
    ).rejects.toBeDefined();
    expect(f.seen.filter((r) => r.input)).toEqual([]);
  } finally {
    forge.close();
    await f.close();
  }
});
