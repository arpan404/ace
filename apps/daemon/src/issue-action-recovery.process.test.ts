import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, type ForgeIssueWrite } from "@ace/protocol";
import {
  fakeGh,
  repository,
  issueRecord,
  issuePermissions,
  type Fixtures,
} from "@ace/forge/testing";
import { GitHubForge, createCommandRunner } from "@ace/forge";
import { Store } from "./store.ts";
import { IssueActions } from "./issue-actions.ts";

const repoPath = "repos/octo/ace";
const issuePath = `${repoPath}/issues/7`;
const lookupPath = `${repoPath}/issues?state=all&sort=created&direction=desc&per_page=100&page=1`;
const create = { action: "create", title: "Draft", body: "Context" } as const;
function command(id: string, input: ForgeIssueWrite = create) {
  return Command.parse({
    id,
    deviceId: "device",
    payload: {
      type: "forge.issue.write",
      workspaceId: "workspace",
      repository,
      input,
    },
  });
}
function reconcile(id: string, actionId: string) {
  return Command.parse({
    id,
    deviceId: "device",
    payload: {
      type: "forge.issue.reconcile",
      workspaceId: "workspace",
      repository,
      actionId,
    },
  });
}
async function environment(fixtures: Fixtures) {
  const gh = await fakeGh(fixtures);
  const root = await mkdtemp(join(tmpdir(), "ace-issue-recovery-"));
  const store = new Store(join(root, "events.sqlite"));
  const actions = new IssueActions(store);
  const signal = new AbortController().signal;
  return {
    gh,
    store,
    actions,
    signal,
    async close() {
      await store.close();
      await gh.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}

for (const failure of ["executable disappears", "cwd disappears", "executable loses permission"]) {
  test(`${failure} after metadata succeeds leaves creation definitely unsent and retryable`, async () => {
    const app = await environment({
      [repoPath]: [{ body: { archived: false, has_issues: true }, barrier: "metadata" }],
      [`${repoPath}/issues`]: [{ body: issueRecord }],
    });
    const cwd = join(app.gh.dir, "spawn-cwd");
    await mkdir(cwd);
    const backend = new GitHubForge({
      repository,
      command: app.gh.executable,
      now: () => 1000,
      runner: createCommandRunner({
        cwd,
        env: {
          FORGE_FIXTURE: join(app.gh.dir, "fixtures.json"),
          FORGE_STATE: join(app.gh.dir, "state.json"),
        },
      }),
    });
    const writing = app.actions.execute(command("unsent"), backend, () => true, app.signal);
    try {
      await app.gh.waitForRequest(repoPath);
      if (failure === "cwd disappears") await rm(cwd, { recursive: true });
      else if (failure === "executable disappears")
        await rename(app.gh.executable, `${app.gh.executable}.saved`);
      else await chmod(app.gh.executable, 0o600);
      await app.gh.release("metadata");
      expect(await writing).toMatchObject({
        ok: false,
        issueAction: { id: "unsent", state: "failed" },
      });
      if (failure === "cwd disappears") await mkdir(cwd);
      else if (failure === "executable disappears")
        await rename(`${app.gh.executable}.saved`, app.gh.executable);
      else await chmod(app.gh.executable, 0o755);
      expect(
        await app.actions.execute(command("fresh"), backend, () => true, app.signal),
      ).toMatchObject({ ok: true });
      expect(
        (await app.gh.requests())
          .filter((request) => request.args.includes("POST"))
          .map((request) => request.body),
      ).toEqual([{ title: "Draft", body: "Context\n\n<!-- ace-issue-action:fresh -->" }]);
    } finally {
      await app.gh.release("metadata");
      await writing;
      await app.close();
    }
  });
}

test("a competing intent refused before reservation returns an unsent outcome without adding an action to the journal", async () => {
  const app = await environment({
    [repoPath]: [{ body: { archived: false, has_issues: true }, barrier: "metadata" }],
    [`${repoPath}/issues`]: [{ body: issueRecord }],
  });
  const first = app.actions.execute(command("first-window"), app.gh.forge, () => true, app.signal);
  try {
    await app.gh.waitForRequest(repoPath);
    expect(
      await app.actions.execute(command("second-window"), app.gh.forge, () => true, app.signal),
    ).toMatchObject({
      ok: false,
      code: "action_not_dispatched",
      issueAction: { id: "second-window", state: "failed" },
    });
    expect(app.actions.list(repository, 0).map((action) => action.id)).toEqual(["first-window"]);
    await app.gh.release("metadata");
    expect(await first).toMatchObject({ ok: true });
    expect(
      await app.actions.execute(
        command("second-window-fresh"),
        app.gh.forge,
        () => true,
        app.signal,
      ),
    ).toMatchObject({ ok: true });
  } finally {
    await app.gh.release("metadata");
    await first;
    await app.close();
  }
});

test("failed creation preflights are definitely unsent and permit a fresh creation", async () => {
  const app = await environment({
    [repoPath]: [{ status: 503 }, { body: { archived: false, has_issues: true } }],
    [`${repoPath}/issues`]: [{ body: issueRecord }],
  });
  try {
    expect(
      await app.actions.execute(command("offline"), app.gh.forge, () => true, app.signal),
    ).toMatchObject({ ok: false, error: "forge_cli", issueAction: { state: "failed" } });
    expect(
      await app.actions.execute(command("retry"), app.gh.forge, () => true, app.signal),
    ).toMatchObject({ ok: true, issue: { number: 7 } });
    expect(
      (await app.gh.requests())
        .filter((request) => request.path === `${repoPath}/issues`)
        .map((request) => request.body),
    ).toEqual([{ title: "Draft", body: "Context\n\n<!-- ace-issue-action:retry -->" }]);
  } finally {
    await app.close();
  }
});

test("revoking authorization during repository preflight prevents POST without leaving an uncertain action", async () => {
  const app = await environment({
    [repoPath]: [{ body: { archived: false, has_issues: true }, barrier: "metadata" }],
    [`${repoPath}/issues`]: [{ body: issueRecord }],
  });
  let allowed = true;
  const writing = app.actions.execute(command("revoked"), app.gh.forge, () => allowed, app.signal);
  try {
    await app.gh.waitForRequest(repoPath);
    allowed = false;
    await app.gh.release("metadata");
    expect(await writing).toMatchObject({
      ok: false,
      error: "forbidden",
      issueAction: { state: "failed" },
    });
    expect((await app.gh.requests()).filter((request) => request.args.includes("POST"))).toEqual(
      [],
    );
    allowed = true;
    expect(
      await app.actions.execute(command("authorized"), app.gh.forge, () => allowed, app.signal),
    ).toMatchObject({ ok: true });
  } finally {
    await app.gh.release("metadata");
    await writing;
    await app.close();
  }
});

test("revoking authorization during permission preflight prevents issue PATCH", async () => {
  const app = await environment({
    [issuePath]: [{ body: issueRecord }],
    graphql: [{ body: issuePermissions(), barrier: "permissions" }],
  });
  let allowed = true;
  const writing = app.actions.execute(
    command("edit", {
      action: "edit",
      number: 7,
      title: "Edited",
      body: "Replaced",
      expectedUpdatedAt: issueRecord.updated_at,
    }),
    app.gh.forge,
    () => allowed,
    app.signal,
  );
  try {
    await app.gh.waitForRequest("graphql");
    allowed = false;
    await app.gh.release("permissions");
    expect(await writing).toMatchObject({
      ok: false,
      error: "forbidden",
      issueAction: { state: "failed" },
    });
    expect((await app.gh.requests()).filter((request) => request.args.includes("PATCH"))).toEqual(
      [],
    );
  } finally {
    await app.gh.release("permissions");
    await writing;
    await app.close();
  }
});

test("active issue writes stay pending and cannot be reconciled before their acknowledgement", async () => {
  const app = await environment({
    [repoPath]: [{ body: { archived: false, has_issues: true } }],
    [`${repoPath}/issues`]: [{ body: issueRecord, barrier: "post" }],
    [lookupPath]: [{ body: [] }],
  });
  const writing = app.actions.execute(command("create"), app.gh.forge, () => true, app.signal);
  try {
    await app.gh.waitForRequest(`${repoPath}/issues`);
    expect(app.actions.list(repository, 0)).toMatchObject([{ id: "create", state: "pending" }]);
    expect(
      await app.actions.execute(reconcile("read", "create"), app.gh.forge, () => true, app.signal),
    ).toMatchObject({ ok: false, error: "forge_write_pending", issueAction: { state: "pending" } });
    expect((await app.gh.requests()).filter((request) => request.path === lookupPath)).toEqual([]);
    await app.gh.release("post");
    expect(await writing).toMatchObject({ ok: true, issueAction: { state: "succeeded" } });
    expect(app.actions.list(repository, 0)).toMatchObject([{ state: "succeeded" }]);
  } finally {
    await app.gh.release("post");
    await writing;
    await app.close();
  }
});

test("a stale reconciliation from another owner cannot downgrade a completed write", async () => {
  const app = await environment({
    [repoPath]: [{ body: { archived: false, has_issues: true } }],
    [`${repoPath}/issues`]: [{ body: issueRecord, barrier: "post" }],
    [lookupPath]: [{ body: [], barrier: "reconciliation" }],
  });
  const other = new IssueActions(app.store);
  const writing = app.actions.execute(command("create"), app.gh.forge, () => true, app.signal);
  let reading: ReturnType<IssueActions["execute"]> | undefined;
  try {
    await app.gh.waitForRequest(`${repoPath}/issues`);
    reading = other.execute(reconcile("read", "create"), app.gh.forge, () => true, app.signal);
    await app.gh.waitForRequest(lookupPath);
    await app.gh.release("post");
    expect(await writing).toMatchObject({ ok: true });
    await app.gh.release("reconciliation");
    expect(await reading).toMatchObject({ ok: true, issueAction: { state: "succeeded" } });
    expect(app.actions.list(repository, 0)).toMatchObject([{ state: "succeeded" }]);
    expect(
      await app.actions.execute(command("next"), app.gh.forge, () => true, app.signal),
    ).toMatchObject({ ok: true });
  } finally {
    await app.gh.release("post");
    await app.gh.release("reconciliation");
    await writing;
    await reading;
    await app.close();
  }
});

test("authorization revoked after dispatch does not erase GitHub's confirmed outcome", async () => {
  const app = await environment({
    [repoPath]: [{ body: { archived: false, has_issues: true } }],
    [`${repoPath}/issues`]: [{ body: issueRecord, barrier: "post" }],
  });
  let allowed = true;
  const writing = app.actions.execute(command("create"), app.gh.forge, () => allowed, app.signal);
  try {
    await app.gh.waitForRequest(`${repoPath}/issues`);
    allowed = false;
    await app.gh.release("post");
    expect(await writing).toMatchObject({ ok: true, issueAction: { state: "succeeded" } });
    expect(app.actions.list(repository, 0)).toMatchObject([{ state: "succeeded" }]);
  } finally {
    await app.gh.release("post");
    await writing;
    await app.close();
  }
});
