import { expect, test } from "vitest";
import { Command } from "@ace/protocol";
import { createCommandRunner, type CommandRequest } from "@ace/forge";
import { reviewFixtures, inlineDraft, repository } from "@ace/forge/testing";
import { setupReview } from "./hosted-review-test-support.ts";
const noop = () => {};
const isWrite = (request: CommandRequest) =>
  request.args.includes("POST") && request.args[1] !== "graphql";

test("a review that cannot spawn gh keeps drafts and permits an explicit retry after restart", async () => {
  let missing = true;
  const f = await setupReview(reviewFixtures(), (request, run) =>
    missing && isWrite(request)
      ? createCommandRunner({ cwd: "/" })({ ...request, command: "/ace-missing-gh" })
      : run(request),
  );
  try {
    await f.send("save", { kind: "draft.save", draft: inlineDraft });
    expect(await f.send("failed-spawn")).toMatchObject({ ok: false, error: "forge_cli" });
    await f.restart();
    missing = false;
    expect(await f.state()).toMatchObject({
      drafts: [{ id: "draft", body: inlineDraft.body }],
      operations: [],
    });
    expect(await f.send("retry")).toMatchObject({ ok: true });
    expect(await f.send("failed-spawn")).toMatchObject({ ok: false, error: "forge_cli" });
    expect(await f.state()).toMatchObject({
      drafts: [],
      operations: [{ id: "retry", state: "accepted" }],
    });
  } finally {
    await f.cleanup();
  }
});

test("active review publication cannot be reconciled through an alias and preserves drafts edited meanwhile", async () => {
  let release = noop;
  let entered = noop;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatched = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = await setupReview(reviewFixtures(), async (request, run) => {
    const response = await run(request);
    if (isWrite(request)) {
      entered();
      await held;
    }
    return response;
  });
  try {
    await f.send("save", { kind: "draft.save", draft: inlineDraft });
    const original = f.send("publish");
    await dispatched;
    const alias = { ...repository, owner: "Octo", name: "Ace" };
    const reconcile = Command.parse({
      id: "check-active",
      deviceId: "other",
      payload: {
        type: "forge.hosted.review",
        workspaceId: f.workspaceId,
        pr: { repository: alias, number: 7 },
        action: { kind: "reconcile", operationId: "publish" },
      },
    });
    expect(await f.runtime.execute(reconcile)).toMatchObject({
      ok: false,
      error: "forge_write_pending",
    });
    await f.send("save-edited", {
      kind: "draft.save",
      draft: { ...inlineDraft, body: "Edited while publishing" },
    });
    release();
    expect(await original).toMatchObject({ ok: true });
    await f.restart();
    expect(await f.state(alias)).toMatchObject({
      drafts: [{ body: "Edited while publishing" }],
      operations: [{ id: "publish", state: "accepted" }],
    });
    expect(
      await f.send("accepted-reconcile", { kind: "reconcile", operationId: "publish" }),
    ).toMatchObject({ ok: true });
    expect(await f.state()).toMatchObject({ drafts: [{ body: "Edited while publishing" }] });
  } finally {
    release();
    await f.cleanup();
  }
});

test("migration preserves conflicting drafts from former repository casing aliases", async () => {
  const f = await setupReview(reviewFixtures());
  try {
    await f.send("save-old", { kind: "draft.save", draft: inlineDraft });
    f.store.atomic((db) =>
      db
        .prepare("UPDATE forge_hosted_drafts SET scope=?")
        .run(JSON.stringify({ repository, number: 7 })),
    );
    await f.send("save-new", {
      kind: "draft.save",
      draft: { ...inlineDraft, body: "New alias draft" },
    });
    await f.restart();
    const state = await f.state({ ...repository, owner: "Octo", name: "Ace" });
    expect(state.drafts.map((draft) => draft.body).toSorted()).toEqual(
      [inlineDraft.body, "New alias draft"].toSorted(),
    );
    expect(new Set(state.drafts.map((draft) => draft.id)).size).toBe(2);
  } finally {
    await f.cleanup();
  }
});
