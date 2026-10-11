import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, DeviceId, WorkspaceActionRequest, type ForgeReviewAction } from "@ace/protocol";
import {
  fakeGh,
  repository,
  sha,
  reviewFixtures,
  reviewHost,
  inlineDraft,
  type Fixtures,
  type Response,
} from "@ace/forge/testing";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { WorkspaceForgeReviews } from "./workspace-forge-reviews.ts";
const submit: ForgeReviewAction = {
  kind: "submit",
  event: "COMMENT",
  headSha: sha,
  body: "Reviewed",
  draftIds: ["draft"],
};
async function setup(fixtures: Fixtures) {
  const root = await mkdtemp(join(tmpdir(), "ace-review-recovery-"));
  const path = join(root, "store.sqlite");
  const gh = await fakeGh(fixtures);
  let store = new Store(path);
  const workspaceId = store.createWorkspace(root, "Project");
  const options = {
    forgeRunner: () => (request: import("@ace/forge").CommandRequest) =>
      gh.runner({ ...request, command: gh.executable }),
  };
  let runtime = new WorkspaceRuntime(store, root, () => 1, options);
  const command = (id: string, action: ForgeReviewAction = submit) =>
    Command.parse({
      id,
      deviceId: "device",
      payload: { type: "forge.hosted.review", workspaceId, pr: { repository, number: 7 }, action },
    });
  return {
    gh,
    command,
    get store() {
      return store;
    },
    send: (id: string, action: ForgeReviewAction = submit) => runtime.execute(command(id, action)),
    async state() {
      const result = await runtime.read(
        WorkspaceActionRequest.parse({
          type: "workspace.request",
          requestId: "state",
          operation: { op: "forge.pr.review-state", workspaceId, repository, number: 7 },
        }),
      );
      if (result.result.kind !== "forge" || result.result.data.resource !== "prReviewState")
        throw new Error("Missing review state");
      return result.result.data.value;
    },
    async restart() {
      await runtime.close();
      await store.close();
      store = new Store(path);
      runtime = new WorkspaceRuntime(store, root, () => 2, options);
    },
    async cleanup() {
      await runtime.close();
      await store.close();
      await gh.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("failed preflight reads retain drafts and permit retry after reconnect or restart", async () => {
  const failures: Response[] = [
    { status: 503 },
    { status: 504 },
    { status: 429 },
    { raw: "offline", code: 1 },
  ];
  for (const failure of failures) {
    const fixtures = reviewFixtures();
    fixtures["graphql:viewer { login }"] = [failure, { body: reviewHost() }];
    const f = await setup(fixtures);
    try {
      await f.send("save", { kind: "draft.save", draft: inlineDraft });
      expect(await f.send("failed")).toMatchObject({
        ok: false,
        error: failure.status === 429 ? "forge_rate_limit" : "forge_cli",
      });
      expect((await f.gh.requests()).some((r) => r.path === "repos/octo/ace/pulls/7/reviews")).toBe(
        false,
      );
      await f.restart();
      expect(await f.state()).toMatchObject({
        drafts: [{ id: "draft", body: inlineDraft.body }],
        operations: [],
      });
      expect(await f.send("retry")).toMatchObject({ ok: true });
      expect(await f.state()).toMatchObject({
        drafts: [],
        operations: [{ id: "retry", state: "accepted" }],
      });
    } finally {
      await f.cleanup();
    }
  }
});

test("a hosted patch lookup failure before publication does not block the selected drafts", async () => {
  const fixtures = reviewFixtures();
  fixtures["repos/octo/ace/pulls/7/files?per_page=100"] = [
    { status: 503 },
    ...(fixtures["repos/octo/ace/pulls/7/files?per_page=100"] ?? []),
  ];
  const f = await setup(fixtures);
  try {
    await f.send("save", { kind: "draft.save", draft: inlineDraft });
    expect(await f.send("failed")).toMatchObject({ ok: false, error: "forge_cli" });
    expect(await f.state()).toMatchObject({ drafts: [{ id: "draft" }], operations: [] });
    expect(await f.send("retry")).toMatchObject({ ok: true });
  } finally {
    await f.cleanup();
  }
});

test("definitive rate-limit refusals release a dispatched review for a later explicit retry", async () => {
  for (const refusal of [
    { status: 429 },
    { status: 403, headers: { "x-ratelimit-remaining": "0" } },
  ]) {
    const fixtures = reviewFixtures();
    fixtures["repos/octo/ace/pulls/7/reviews"] = [
      refusal,
      ...(fixtures["repos/octo/ace/pulls/7/reviews"] ?? []),
    ];
    const f = await setup(fixtures);
    try {
      await f.send("save", { kind: "draft.save", draft: inlineDraft });
      expect(await f.send("limited")).toMatchObject({ ok: false, error: "forge_rate_limit" });
      await f.restart();
      expect(await f.state()).toMatchObject({ drafts: [{ id: "draft" }], operations: [] });
      expect(await f.send("retry")).toMatchObject({ ok: true });
    } finally {
      await f.cleanup();
    }
  }
});

test("journal acceptance completes the original receipt before the outer command runner resumes", async () => {
  const f = await setup(reviewFixtures());
  try {
    await f.send("save", { kind: "draft.save", draft: inlineDraft });
    const command = f.command("accepted");
    f.store.recordCommand(command.id, command.deviceId, () => ({
      commandId: command.id,
      ok: false,
      error: "client_action_pending",
    }));
    await new WorkspaceForgeReviews(f.store).execute(
      command.payload,
      command.id,
      f.gh.forge,
      new AbortController().signal,
      () => true,
    );
    expect(f.store.commandReceipt(command.id, command.deviceId)).toMatchObject({ ok: true });
    await f.restart();
    expect(await f.send("accepted")).toMatchObject({ ok: true });
    expect(await f.state()).toMatchObject({
      drafts: [],
      operations: [{ id: "accepted", state: "accepted" }],
    });
    expect(
      (await f.gh.requests()).filter((r) => r.path === "repos/octo/ace/pulls/7/reviews"),
    ).toHaveLength(1);
    expect(
      await f.store.commandReceipt(command.id, DeviceId.parse("another-device")),
    ).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

test("an accepted journal from the old crash window recovers its pending receipt without republishing", async () => {
  const f = await setup(reviewFixtures());
  try {
    await f.send("save", { kind: "draft.save", draft: inlineDraft });
    expect(await f.send("accepted")).toMatchObject({ ok: true });
    // Persisted facts produced by the previous implementation after journal acceptance.
    f.store.atomic((db) =>
      db
        .prepare("UPDATE command_receipts SET result=? WHERE command_id=?")
        .run(
          JSON.stringify({ commandId: "accepted", ok: false, error: "client_action_pending" }),
          "accepted",
        ),
    );
    await f.restart();
    expect(await f.send("accepted")).toMatchObject({ ok: true });
    expect(
      (await f.gh.requests()).filter((r) => r.path === "repos/octo/ace/pulls/7/reviews"),
    ).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("a definite GraphQL rate limit releases the thread action, while partial acknowledgement stays uncertain", async () => {
  for (const partial of [false, true]) {
    const fixtures = reviewFixtures();
    fixtures["graphql:mutation($input:ResolveReviewThreadInput!"] = [
      {
        body: {
          data: { resolveReviewThread: partial ? { clientMutationId: "resolve" } : null },
          errors: [{ type: "RATE_LIMITED" }],
        },
      },
    ];
    const f = await setup(fixtures);
    try {
      expect(await f.send("resolve", { kind: "thread.resolve", threadId: "T_7" })).toMatchObject({
        ok: false,
        error: partial ? "action_outcome_uncertain" : "forge_rate_limit",
      });
      expect((await f.state()).operations).toEqual(
        partial ? [{ id: "resolve", state: "uncertain" }] : [],
      );
    } finally {
      await f.cleanup();
    }
  }
});
