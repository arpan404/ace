import { expect, test } from "vitest";
import { Command, Thread, ThreadId } from "@ace/protocol";
import { createCommandRunner, ForgeStore, type CommandRequest } from "@ace/forge";
import {
  lifecycleFixtures,
  lifecycleRecord,
  sha,
  repository,
  standard,
  pr,
  nextSha,
} from "@ace/forge/testing";
import { setupLifecycle } from "./forge-lifecycle-test-support.ts";
const noop = () => {};
const noopAsync = async () => {};
const mutation = "graphql:mutation($input:UpdatePullRequestInput!";
const isWrite = (request: CommandRequest) => request.input?.includes("mutation($input:") === true;
const editedFixtures = (title: string) => {
  const fixtures = lifecycleFixtures([lifecycleRecord({ title })]);
  fixtures[mutation] = [
    { body: { data: { updatePullRequest: { pullRequest: { headRefOid: sha } } } } },
  ];
  return fixtures;
};

test("a CLI that cannot spawn releases its write fence across a restart", async () => {
  let missing = true;
  let publish = noopAsync;
  const f = await setupLifecycle(editedFixtures("Fix build"), async (request, run) => {
    if (missing && isWrite(request))
      return createCommandRunner({ cwd: "/" })({ ...request, command: "/ace-missing-gh" });
    const response = await run(request);
    if (isWrite(request)) await publish();
    return response;
  });
  try {
    const before = await f.read();
    const action = { kind: "edit", changes: { title: "A" } } as const;
    expect(await f.send("spawn-failed", action, before.snapshot.version)).toMatchObject({
      ok: false,
      error: "forge_cli",
    });
    await f.restart();
    missing = false;
    expect((await f.read()).operations).toEqual([]);
    publish = () => f.gh.replace(editedFixtures("A"));
    const retry = await f.send("explicit-retry", action, before.snapshot.version);
    expect(retry.ok).toBe(true);
    expect((await f.read()).operations).toContainEqual(
      expect.objectContaining({ id: "explicit-retry", state: "accepted" }),
    );
    expect(
      await f.runtime.execute(f.command("spawn-failed", action, before.snapshot.version)),
    ).toMatchObject({ ok: false, error: "forge_cli" });
  } finally {
    await f.cleanup();
  }
});

test("an active mutation cannot be reconciled or bypassed through a repository casing alias", async () => {
  let release = noop;
  let entered = noop;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatched = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let hold = true;
  const f = await setupLifecycle(editedFixtures("Fix build"), async (request, run) => {
    const response = await run(request);
    if (hold && isWrite(request)) {
      hold = false;
      entered();
      await held;
    }
    return response;
  });
  try {
    const before = await f.read();
    const command = f.command(
      "edit-A",
      { kind: "edit", changes: { title: "A" } },
      before.snapshot.version,
    );
    const original = f.runtime.execute(command);
    await dispatched;
    await f.gh.replace(editedFixtures("A"));
    const alias = {
      repository: { ...repository, owner: "Octo", name: "Ace", host: "GitHub.com" },
      number: 7,
    };
    expect(
      await f.runtime.execute(
        Command.parse({
          id: "other-client",
          deviceId: "other",
          payload: {
            type: "forge.hosted.lifecycle",
            workspaceId: f.workspaceId,
            pr: alias,
            operation: { kind: "reconcile", operationId: "edit-A" },
          },
        }),
      ),
    ).toMatchObject({ ok: false, error: "forge_write_pending" });
    expect(
      await f.runtime.execute(
        Command.parse({
          ...f.command(
            "edit-B-early",
            { kind: "edit", changes: { title: "B" } },
            before.snapshot.version,
          ),
          payload: { ...command.payload, pr: alias },
        }),
      ),
    ).toMatchObject({ ok: false, error: "forge_write_pending" });
    release();
    expect(await original).toMatchObject({ ok: true, forgeLifecycle: { outcome: "accepted" } });
    const accepted = await f.runtime.execute(command);
    await f.gh.replace(editedFixtures("B"));
    expect(await f.reconcile("edit-A")).toMatchObject({
      ok: true,
      forgeLifecycle: { outcome: "accepted" },
    });
    expect(await f.runtime.execute(command)).toEqual(accepted);
    expect((await f.read()).operations).toContainEqual(
      expect.objectContaining({ id: "edit-A", state: "accepted" }),
    );
  } finally {
    release();
    await f.cleanup();
  }
});

test("an uncertain write remains visible and fenced under casing aliases after restart", async () => {
  const fixtures = lifecycleFixtures();
  fixtures[mutation] = [{ raw: "lost response", code: 1 }];
  const f = await setupLifecycle(fixtures);
  try {
    const before = await f.read();
    const command = f.command(
      "uncertain-A",
      { kind: "edit", changes: { title: "A" } },
      before.snapshot.version,
    );
    expect(await f.runtime.execute(command)).toMatchObject({ error: "action_outcome_uncertain" });
    // Also exercise migration of a journal written using the former case-sensitive key.
    f.store.atomic((db) =>
      db
        .prepare("UPDATE forge_lifecycle_writes SET scope=? WHERE id=?")
        .run(JSON.stringify({ repository, number: 7 }), command.id),
    );
    await f.restart();
    const alias = { ...repository, owner: "Octo", name: "Ace" };
    const aliasFixtures = Object.fromEntries(
      Object.entries(fixtures).map(([key, value]) => [
        key.replace("repos/octo/ace", "repos/Octo/Ace"),
        value,
      ]),
    );
    await f.gh.replace(aliasFixtures);
    const read = await f.runtime.read({
      type: "workspace.request",
      requestId: "alias-read",
      operation: {
        op: "forge.pr.lifecycle",
        workspaceId: f.workspaceId,
        repository: alias,
        number: 7,
      },
    });
    expect(read.result).toMatchObject({
      kind: "forge",
      data: { value: { operations: [{ id: "uncertain-A", state: "uncertain" }] } },
    });
    expect(
      await f.runtime.execute(
        Command.parse({
          ...command,
          id: "alias-retry",
          payload: { ...command.payload, pr: { repository: alias, number: 7 } },
        }),
      ),
    ).toMatchObject({ ok: false, error: "action_outcome_uncertain" });
  } finally {
    await f.cleanup();
  }
});

const makeFixtures = (closed: boolean) => {
  const fixtures = {
    ...standard(),
    ...lifecycleFixtures([lifecycleRecord({ state: closed ? "CLOSED" : "OPEN" })]),
  };
  fixtures["repos/octo/ace/pulls/7"] = [
    {
      body: {
        ...pr,
        state: closed ? "closed" : "open",
        body: "Description",
        user: { login: "octo" },
        labels: [],
        base: { ref: "main", sha: nextSha },
        head: { ...pr.head, repo: { owner: { login: "octo" }, name: "ace" } },
        requested_reviewers: [],
        commits: 1,
        changed_files: 1,
      },
    },
  ];
  fixtures["graphql:reviewDecision"] = [
    {
      body: { data: { repository: { pullRequest: { reviewDecision: null, headRefOid: sha } } } },
    },
  ];
  fixtures["graphql:mutation($input:ClosePullRequestInput!"] = [
    { body: { data: { closePullRequest: { pullRequest: { headRefOid: sha } } } } },
  ];
  return fixtures;
};

test("a delayed detail read cannot reopen linked threads after a lifecycle close", async () => {
  let release = noop;
  let entered = noop;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayed = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let hold = true;
  let closeHost = noopAsync;
  const f = await setupLifecycle(makeFixtures(false), async (request, run) => {
    const response = await run(request);
    if (hold && request.args[1]?.includes("check-runs")) {
      hold = false;
      entered();
      await held;
    }
    if (isWrite(request)) await closeHost();
    return response;
  });
  try {
    closeHost = () => f.gh.replace(makeFixtures(true));
    const thread = Thread.parse({
      id: "linked",
      workspaceId: f.workspaceId,
      provider: "codex",
      title: "Task",
      status: { state: "new" },
      createdAt: 1,
      updatedAt: 1,
    });
    f.store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
    f.store.atomic((db) =>
      new ForgeStore(db).link({ threadId: thread.id, pr: { repository, number: 7 } }),
    );
    const initial = await f.read();
    const detail = f.runtime.read({
      type: "workspace.request",
      requestId: "delayed-detail",
      operation: { op: "forge.pr.detail", workspaceId: f.workspaceId, repository, number: 7 },
    });
    await delayed;
    expect(await f.send("close", { kind: "close" }, initial.snapshot.version)).toMatchObject({
      ok: true,
      forgeLifecycle: { outcome: "accepted" },
    });
    expect(f.store.getThread(ThreadId.parse("linked"))?.details?.linkedPrs?.[0]?.state).toBe(
      "closed",
    );
    release();
    expect((await detail).result).toMatchObject({ kind: "forge", data: { resource: "prDetail" } });
    expect(f.store.getThread(ThreadId.parse("linked"))?.details?.linkedPrs?.[0]?.state).toBe(
      "closed",
    );
  } finally {
    release();
    await f.cleanup();
  }
});

test("a newer lifecycle refresh after an external close fences an older detail publication", async () => {
  let release = noop;
  let entered = noop;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayed = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let hold = true;
  const f = await setupLifecycle(makeFixtures(false), async (request, run) => {
    const response = await run(request);
    if (hold && request.args[1]?.includes("check-runs")) {
      hold = false;
      entered();
      await held;
    }
    return response;
  });
  try {
    const thread = Thread.parse({
      id: "linked",
      workspaceId: f.workspaceId,
      provider: "codex",
      title: "Task",
      status: { state: "new" },
      createdAt: 1,
      updatedAt: 1,
    });
    f.store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
    f.store.atomic((db) =>
      new ForgeStore(db).link({ threadId: thread.id, pr: { repository, number: 7 } }),
    );
    await f.read();
    const detail = f.runtime.read({
      type: "workspace.request",
      requestId: "delayed-detail",
      operation: { op: "forge.pr.detail", workspaceId: f.workspaceId, repository, number: 7 },
    });
    await delayed;
    // Model an external gh close: no local mutation changes the owner's revision.
    await f.gh.replace(makeFixtures(true));
    expect((await f.read()).snapshot.state).toBe("closed");
    expect(f.store.getThread(thread.id)?.details?.linkedPrs?.[0]?.state).toBe("closed");
    release();
    expect((await detail).result).toMatchObject({ kind: "forge", data: { resource: "prDetail" } });
    expect(f.store.getThread(thread.id)?.details?.linkedPrs?.[0]?.state).toBe("closed");
  } finally {
    release();
    await f.cleanup();
  }
});
