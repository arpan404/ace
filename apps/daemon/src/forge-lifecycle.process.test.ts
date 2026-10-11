import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command, Thread, WorkspaceActionRequest, type ForgeLifecycleAction } from "@ace/protocol";
import { ForgeStore, lifecycleWriteMarker } from "@ace/forge";
import { fakeGh, lifecycleFixtures, lifecycleRecord, repository, sha } from "@ace/forge/testing";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
async function setup(fixtures: import("@ace/forge/testing").Fixtures) {
  const root = await mkdtemp(join(tmpdir(), "ace-lifecycle-"));
  const gh = await fakeGh(fixtures);
  const path = join(root, "store.sqlite");
  let store = new Store(path);
  const workspaceId = store.createWorkspace(root, "Project");
  const options = {
    forgeRunner: () => (request: import("@ace/forge").CommandRequest) =>
      gh.runner({ ...request, command: gh.executable }),
  };
  let runtime = new WorkspaceRuntime(store, root, () => 1000, options);
  const pr = { repository, number: 7 };
  const read = async () => {
    const result = await runtime.read(
      WorkspaceActionRequest.parse({
        type: "workspace.request",
        requestId: "read",
        operation: { op: "forge.pr.lifecycle", workspaceId, repository, number: 7 },
      }),
    );
    if (result.result.kind !== "forge" || result.result.data.resource !== "prLifecycle")
      throw new Error("Missing lifecycle state");
    return result.result.data.value;
  };
  return {
    gh,
    root,
    workspaceId,
    get store() {
      return store;
    },
    get runtime() {
      return runtime;
    },
    read,
    send(id: string, action: ForgeLifecycleAction, expectedVersion: string) {
      return runtime.execute(
        Command.parse({
          id,
          deviceId: "device",
          payload: {
            type: "forge.hosted.lifecycle",
            workspaceId,
            pr,
            operation: { kind: "apply", action, expectedVersion },
          },
        }),
      );
    },
    reconcile(operationId: string) {
      return runtime.execute(
        Command.parse({
          id: `reconcile-${operationId}`,
          deviceId: "device",
          payload: {
            type: "forge.hosted.lifecycle",
            workspaceId,
            pr,
            operation: { kind: "reconcile", operationId },
          },
        }),
      );
    },
    async restart() {
      await runtime.close();
      await store.close();
      store = new Store(path);
      runtime = new WorkspaceRuntime(store, root, () => 2000, options);
    },
    async cleanup() {
      await runtime.close();
      await store.close();
      await gh.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}

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
      JSON.stringify(r.body).includes("mutation($input:RevertPullRequestInput!"),
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
