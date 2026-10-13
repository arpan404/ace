import { setupLifecycle as setup } from "./forge-lifecycle-test-support.ts";
import { expect, test } from "vitest";
import { Thread, type ForgeLifecycleAction } from "@ace/protocol";
import { ForgeStore, lifecycleWriteMarker } from "@ace/forge";
import { lifecycleFixtures, lifecycleRecord, repository, sha } from "@ace/forge/testing";
import { WorkspaceForgeLifecycle } from "./workspace-forge-lifecycle.ts";

test("lifecycle refresh updates every linked thread, including secondary associations and archived tasks", async () => {
  const f = await setup(
    lifecycleFixtures([lifecycleRecord({ state: "CLOSED", title: "Closed outside ace" })]),
  );
  try {
    const active = Thread.parse({
      id: "active",
      workspaceId: f.workspaceId,
      provider: "codex",
      title: "Active",
      status: { state: "new" },
      createdAt: 1,
      updatedAt: 1,
    });
    const archived = Thread.parse({ ...active, id: "archived", title: "Archived", archivedAt: 2 });
    for (const thread of [active, archived])
      f.store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
    f.store.atomic((db) => {
      const links = new ForgeStore(db);
      links.link({ threadId: active.id, pr: { repository, number: 7 } });
      links.link({ threadId: active.id, pr: { repository, number: 8 } });
      links.link({ threadId: archived.id, pr: { repository, number: 7 } });
    });
    expect((await f.read()).snapshot.state).toBe("closed");
    for (const id of [active.id, archived.id])
      expect(f.store.getThread(id)?.details?.linkedPrs).toContainEqual(
        expect.objectContaining({ number: 7, state: "closed", title: "Closed outside ace" }),
      );
    expect(f.store.getThread(active.id)?.details?.linkedPrs?.[0]?.number).toBe(8);
    expect(f.store.getThread(active.id)?.status.state).toBe("new");
    expect(f.store.getThread(archived.id)?.archivedAt).toBe(2);
  } finally {
    await f.cleanup();
  }
});

test("an uncertain revert survives restart and is reconciled without creating another PR", async () => {
  const merged = lifecycleRecord({ state: "MERGED", mergeCommit: { oid: sha } });
  const fixtures = lifecycleFixtures([merged]);
  fixtures["graphql:mutation($input:RevertPullRequestInput!"] = [{ raw: "lost reply", code: 1 }];
  fixtures["repos/octo/ace/pulls?state=all&sort=created&direction=desc&per_page=100"] = [
    { status: 503 },
    {
      body: [{ number: 8, title: "Revert", body: `Undo #7\n\n${lifecycleWriteMarker("revert")}` }],
    },
  ];
  const f = await setup(fixtures);
  try {
    const initial = await f.read();
    expect(
      await f.send(
        "revert",
        { kind: "revert", title: "Revert", body: "Undo #7" },
        initial.snapshot.version,
      ),
    ).toMatchObject({ ok: false, error: "action_outcome_uncertain" });
    await f.restart();
    expect(await f.read()).toMatchObject({ operations: [{ id: "revert", state: "uncertain" }] });
    expect(
      await f.send(
        "duplicate",
        { kind: "revert", title: "Revert", body: "Undo #7" },
        initial.snapshot.version,
      ),
    ).toMatchObject({ ok: false, error: "action_outcome_uncertain" });
    expect(await f.reconcile("revert")).toMatchObject({
      ok: true,
      forgeLifecycle: { outcome: "accepted", revertPr: { number: 8 } },
    });
    expect(await f.read()).toMatchObject({
      snapshot: { state: "merged" },
      operations: [{ id: "revert", state: "accepted", revertPr: { number: 8 } }],
    });
    const mutations = (await f.gh.requests()).filter((r) =>
      JSON.stringify(r.body ?? null).includes("mutation($input:RevertPullRequestInput!"),
    );
    expect(mutations).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("a definite host refusal retains the original metadata and permits a later explicit action", async () => {
  const fixtures = lifecycleFixtures();
  fixtures["graphql:mutation($input:UpdatePullRequestInput!"] = [{ status: 403 }];
  const f = await setup(fixtures);
  try {
    const initial = await f.read();
    expect(
      await f.send(
        "edit",
        { kind: "edit", changes: { body: "Unsaved description" } },
        initial.snapshot.version,
      ),
    ).toMatchObject({ ok: false, error: "forge_forbidden" });
    expect(await f.read()).toMatchObject({
      snapshot: { metadata: { body: "Original description" } },
      operations: [],
    });
    expect(
      await f.send(
        "retry-edit",
        { kind: "edit", changes: { body: "Unsaved description" } },
        initial.snapshot.version,
      ),
    ).toMatchObject({ ok: false, error: "forge_forbidden" });
  } finally {
    await f.cleanup();
  }
});

const revert: ForgeLifecycleAction = { kind: "revert", title: "Revert", body: "Undo #7" };
function mergedFixtures() {
  const fixtures = lifecycleFixtures([
    lifecycleRecord({ state: "MERGED", mergeCommit: { oid: sha } }),
  ]);
  fixtures["graphql:mutation($input:RevertPullRequestInput!"] = [
    { body: { data: { revertPullRequest: { revertPullRequest: { number: 8 } } } } },
  ];
  return fixtures;
}

test("lifecycle preflight failures never reserve an uncertain write and allow retry after restart", async () => {
  for (const failure of [{ status: 503 }, { status: 504 }, { status: 429 }, { offline: true }]) {
    const fixtures = mergedFixtures();
    const key = "graphql:query AceLifecycleSnapshot";
    const valid = fixtures[key]?.[0];
    if (!valid) throw new Error("Missing host fixture");
    fixtures[key] = [valid, failure, valid];
    const f = await setup(fixtures);
    try {
      const { snapshot } = await f.read();
      expect(await f.send("failed", revert, snapshot.version)).toMatchObject({
        ok: false,
        error: "status" in failure && failure.status === 429 ? "forge_rate_limit" : "forge_cli",
      });
      expect(
        (await f.gh.requests()).some((r) => JSON.stringify(r.body).includes("mutation($input:")),
      ).toBe(false);
      await f.restart();
      expect((await f.read()).operations).toEqual([]);
      expect(await f.send("retry", revert, snapshot.version)).toMatchObject({
        ok: true,
        forgeLifecycle: { revertPr: { number: 8 } },
      });
    } finally {
      await f.cleanup();
    }
  }
});

test("definite HTTP and GraphQL rate limits release lifecycle mutations for a later explicit retry", async () => {
  for (const refusal of [
    { status: 429 },
    { status: 403, headers: { "x-ratelimit-remaining": "0" } },
    {
      code: 1,
      stderr: "gh: API rate limit exceeded for user ID 1.",
      body: {
        data: { revertPullRequest: null },
        errors: [
          {
            type: "RATE_LIMITED",
            message: "API rate limit exceeded for user ID 1.",
            path: ["revertPullRequest"],
          },
        ],
      },
    },
  ]) {
    const fixtures = mergedFixtures();
    const key = "graphql:mutation($input:RevertPullRequestInput!";
    fixtures[key] = [refusal, ...(fixtures[key] ?? [])];
    const f = await setup(fixtures);
    try {
      const { snapshot } = await f.read();
      expect(await f.send("limited", revert, snapshot.version)).toMatchObject({
        ok: false,
        error: "forge_rate_limit",
      });
      await f.restart();
      expect((await f.read()).operations).toEqual([]);
      expect(await f.send("retry", revert, snapshot.version)).toMatchObject({
        ok: true,
        forgeLifecycle: { revertPr: { number: 8 } },
      });
    } finally {
      await f.cleanup();
    }
  }
});

test("a revert journal completes its original receipt before the outer command runner resumes", async () => {
  const f = await setup(mergedFixtures());
  try {
    const { snapshot } = await f.read();
    const command = f.command("accepted", revert, snapshot.version);
    f.store.recordCommand(command.id, command.deviceId, () => ({
      commandId: command.id,
      ok: false,
      error: "client_action_pending",
    }));
    await new WorkspaceForgeLifecycle(f.store).execute(
      command.payload,
      command.id,
      f.gh.forge,
      new AbortController().signal,
      () => true,
    );
    expect(f.store.commandReceipt(command.id, command.deviceId)).toMatchObject({
      ok: true,
      forgeLifecycle: { outcome: "accepted", revertPr: { number: 8 } },
    });
    await f.restart();
    expect(await f.send("accepted", revert, snapshot.version)).toMatchObject({
      ok: true,
      forgeLifecycle: { revertPr: { number: 8 } },
    });
    expect(
      (await f.gh.requests()).filter((r) =>
        JSON.stringify(r.body ?? null).includes("mutation($input:RevertPullRequestInput!"),
      ),
    ).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("the old crash window recovers accepted, pending and changed-head lifecycle receipts without repeating mutations", async () => {
  for (const outcome of ["accepted", "pending", "head_changed"] as const) {
    const fixtures = outcome === "accepted" ? mergedFixtures() : lifecycleFixtures();
    if (outcome !== "accepted")
      fixtures["graphql:mutation($input:UpdatePullRequestBranchInput!"] = [
        {
          body: {
            data: {
              updatePullRequestBranch: {
                pullRequest: { headRefOid: outcome === "pending" ? sha : "b".repeat(40) },
              },
            },
          },
        },
      ];
    const action: ForgeLifecycleAction = outcome === "accepted" ? revert : { kind: "update.merge" };
    const f = await setup(fixtures);
    try {
      const { snapshot } = await f.read();
      const result = await f.send("completed", action, snapshot.version);
      expect(result).toMatchObject({ ok: true, forgeLifecycle: { outcome } });
      // Persisted facts from the former gap after saving a journal receipt.
      f.store.atomic((db) =>
        db
          .prepare("UPDATE command_receipts SET result=? WHERE command_id=?")
          .run(
            JSON.stringify({ commandId: "completed", ok: false, error: "client_action_pending" }),
            "completed",
          ),
      );
      await f.restart();
      expect(await f.send("completed", action, snapshot.version)).toEqual(result);
      expect(
        (await f.gh.requests()).filter((r) => JSON.stringify(r.body).includes("mutation($input:")),
      ).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  }
});

test("partial GraphQL acknowledgement keeps a lifecycle mutation uncertain until its host result is established", async () => {
  const fixtures = mergedFixtures();
  fixtures["graphql:mutation($input:RevertPullRequestInput!"] = [
    {
      code: 1,
      stderr: "gh: API rate limit exceeded for user ID 1.",
      body: {
        data: { revertPullRequest: { revertPullRequest: { number: 8 } } },
        errors: [
          {
            type: "RATE_LIMITED",
            message: "API rate limit exceeded for user ID 1.",
            path: ["revertPullRequest"],
          },
        ],
      },
    },
  ];
  fixtures["repos/octo/ace/pulls?state=all&sort=created&direction=desc&per_page=100"] = [
    { status: 503 },
  ];
  const f = await setup(fixtures);
  try {
    const { snapshot } = await f.read();
    expect(await f.send("partial", revert, snapshot.version)).toMatchObject({
      ok: false,
      error: "action_outcome_uncertain",
    });
    expect((await f.read()).operations).toEqual([
      { id: "partial", kind: "revert", state: "uncertain" },
    ]);
  } finally {
    await f.cleanup();
  }
});

test("rate-limited observation after a successful lifecycle dispatch never releases its uncertain journal", async () => {
  const original = lifecycleRecord();
  const closed = lifecycleRecord({ state: "CLOSED" });
  const fixtures = lifecycleFixtures([original, original, original, original, closed]);
  const key = "graphql:query AceLifecycleSnapshot";
  const records = fixtures[key] ?? [];
  fixtures[key] = [...records.slice(0, 4), { status: 429 }, { status: 429 }, ...records.slice(4)];
  fixtures["graphql:mutation($input:ClosePullRequestInput!"] = [
    { body: { data: { closePullRequest: { pullRequest: { headRefOid: sha } } } } },
  ];
  const f = await setup(fixtures);
  try {
    const { snapshot } = await f.read();
    expect(await f.send("close", { kind: "close" }, snapshot.version)).toMatchObject({
      ok: false,
      error: "action_outcome_uncertain",
    });
    await f.restart();
    expect((await f.read()).operations).toEqual([
      { id: "close", kind: "close", state: "uncertain" },
    ]);
    expect(await f.reconcile("close")).toMatchObject({
      ok: true,
      forgeLifecycle: { outcome: "accepted" },
    });
    expect(
      (await f.gh.requests()).filter((r) =>
        JSON.stringify(r.body).includes("mutation($input:ClosePullRequestInput!"),
      ),
    ).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});
