import { setupReview as setup } from "./hosted-review-test-support.ts";
import { expect, test } from "vitest";
import { DeviceId } from "@ace/protocol";
import { reviewFixtures, reviewHost, inlineDraft, type Response } from "@ace/forge/testing";
import { WorkspaceForgeReviews } from "./workspace-forge-reviews.ts";

test("failed preflight reads retain drafts and permit retry after reconnect or restart", async () => {
  const failures: Response[] = [
    { status: 503 },
    { status: 504 },
    { status: 429 },
    { offline: true },
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
        code: 1,
        stderr: "gh: API rate limit exceeded for user ID 1.",
        body: {
          data: { resolveReviewThread: partial ? { clientMutationId: "resolve" } : null },
          errors: [
            {
              type: "RATE_LIMITED",
              message: "API rate limit exceeded for user ID 1.",
              path: ["resolveReviewThread"],
            },
          ],
        },
      },
    ];
    const f = await setup(fixtures);
    try {
      expect(await f.send("resolve", { kind: "thread.resolve", threadId: "T_7" })).toMatchObject({
        ok: false,
        error: partial ? "action_outcome_uncertain" : "forge_rate_limit",
      });
      await f.restart();
      expect((await f.state()).operations).toEqual(
        partial ? [{ id: "resolve", state: "uncertain" }] : [],
      );
      await f.gh.replace({
        ...reviewFixtures(),
        "graphql:mutation($input:ResolveReviewThreadInput!": [
          {
            body: { data: { resolveReviewThread: { clientMutationId: "explicit-retry" } } },
          },
        ],
      });
      expect(
        await f.send("explicit-retry", { kind: "thread.resolve", threadId: "T_7" }),
      ).toMatchObject(partial ? { ok: false, error: "action_outcome_uncertain" } : { ok: true });
    } finally {
      await f.cleanup();
    }
  }
});
