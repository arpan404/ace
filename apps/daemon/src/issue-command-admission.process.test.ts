import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { Command, type CommandResult } from "@ace/protocol";
import { fakeGh, repository, issueRecord } from "@ace/forge/testing";
import { Store } from "./store.ts";
import { AsyncCommands } from "./async-commands.ts";
import { IssueActions } from "./issue-actions.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

async function environment() {
  const root = await mkdtemp(join(tmpdir(), "ace-issue-admission-"));
  const gh = await fakeGh({
    "repos/octo/ace": [{ body: { archived: false, has_issues: true } }],
    "repos/octo/ace/issues": [{ body: issueRecord }],
  });
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const command = (id: string) =>
    Command.parse({
      id,
      deviceId: "device",
      payload: {
        type: "forge.issue.write",
        workspaceId,
        repository,
        input: { action: "create", title: "Preserved title", body: "Preserved body" },
      },
    });
  return {
    root,
    gh,
    store,
    command,
    async close() {
      await store.close();
      await gh.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("outer command capacity refuses a fresh issue intent without journal ownership and permits a later write", async () => {
  const app = await environment();
  const outer = new AsyncCommands(app.store);
  const issues = new IssueActions(app.store);
  const gate = Promise.withResolvers<void>();
  const active: Promise<CommandResult>[] = [];
  const ready: Promise<void>[] = [];
  for (let i = 0; i < 16; i++) {
    const entered = Promise.withResolvers<void>();
    ready.push(entered.promise);
    active.push(
      outer.run(
        Command.parse({
          id: `holding-${i}`,
          deviceId: "device",
          payload: { type: "workspace.editor.open", threadId: "task", editorId: "code" },
        }),
        async () => {
          await writeFile(join(app.root, `holding-${i}`), "active");
          entered.resolve();
          await gate.promise;
          return { ok: true };
        },
      ),
    );
  }
  const effect = () =>
    issues.execute(
      app.command("capacity-refused"),
      app.gh.forge,
      () => true,
      new AbortController().signal,
    );
  try {
    await Promise.all(ready);
    expect(await outer.run(app.command("capacity-refused"), effect)).toMatchObject({
      ok: false,
      error: "action_busy",
      code: "action_not_dispatched",
      issueAction: { id: "capacity-refused", action: "create", state: "failed" },
    });
    expect(issues.list(repository, 0)).toEqual([]);
    expect(
      app.store.commandReceipt(
        app.command("capacity-refused").id,
        app.command("capacity-refused").deviceId,
      ),
    ).toBeUndefined();
    gate.resolve();
    await Promise.all(active);
    expect(await outer.run(app.command("capacity-refused"), effect)).toMatchObject({
      ok: true,
      issue: { number: 7 },
    });
    expect(
      (await app.gh.requests())
        .filter((request) => request.args.includes("POST"))
        .map((request) => request.body),
    ).toEqual([
      {
        title: "Preserved title",
        body: "Preserved body\n\n<!-- ace-issue-action:capacity-refused -->",
      },
    ]);
  } finally {
    gate.resolve();
    await Promise.allSettled(active);
    await outer.drained();
    await app.close();
  }
});

for (const refusal of ["unauthorized", "missing workspace", "unsupported forge"] as const) {
  test(`an early ${refusal} refusal leaves no issue journal and remains retryable after restart`, async () => {
    const app = await environment();
    const options = {
      forgeRunner: () => (request: import("@ace/forge").CommandRequest) =>
        app.gh.runner({ ...request, command: app.gh.executable }),
    };
    let runtime = new WorkspaceRuntime(app.store, app.root, () => 1000, options);
    const original = app.command("preflight-refused");
    if (original.payload.type !== "forge.issue.write") throw new Error("Expected issue write");
    const refused = Command.parse({
      ...original,
      payload: {
        ...original.payload,
        ...(refusal === "missing workspace" ? { workspaceId: "missing" } : {}),
        ...(refusal === "unsupported forge"
          ? { repository: { ...repository, forge: "gitlab" } }
          : {}),
      },
    });
    try {
      expect(await runtime.execute(refused, () => refusal !== "unauthorized")).toMatchObject({
        ok: false,
        code: "action_not_dispatched",
        issueAction: { id: "preflight-refused", state: "failed", action: "create" },
      });
      expect(
        await runtime.read({
          type: "workspace.request",
          requestId: "journal",
          operation: {
            op: "forge.issue.actions",
            workspaceId: original.payload.workspaceId,
            repository,
            number: 0,
          },
        }),
      ).toMatchObject({
        result: { kind: "forge", data: { resource: "issueActions", actions: [] } },
      });
      await runtime.close();
      runtime = new WorkspaceRuntime(app.store, app.root, () => 2000, options);
      expect(await runtime.execute(app.command("fresh-intent"))).toMatchObject({
        ok: true,
        issue: { number: 7 },
      });
      expect(
        (await app.gh.requests())
          .filter((request) => request.args.includes("POST"))
          .map((request) => request.body),
      ).toEqual([
        {
          title: "Preserved title",
          body: "Preserved body\n\n<!-- ace-issue-action:fresh-intent -->",
        },
      ]);
    } finally {
      await runtime.close();
      await app.close();
    }
  });
}

test("full capacity keeps a previously admitted pending command uncertain instead of declaring it unsent", async () => {
  const app = await environment();
  const outer = new AsyncCommands(app.store);
  const gate = Promise.withResolvers<void>();
  const replay = app.command("previously-admitted");
  app.store.recordCommand(replay.id, replay.deviceId, () => ({
    commandId: replay.id,
    ok: false,
    error: "client_action_pending",
  }));
  const active = Array.from({ length: 16 }, (_, i) =>
    outer.run(app.command(`other-${i}`), async () => {
      await gate.promise;
      return { ok: true };
    }),
  );
  try {
    const result = await outer.run(replay, async () => {
      await writeFile(join(app.root, "repeated-write"), "unsafe");
      return { ok: true };
    });
    expect(result).toMatchObject({ ok: false, error: "action_outcome_uncertain" });
    expect(result.code).toBeUndefined();
    expect(result.issueAction).toBeUndefined();
    await expect(readFile(join(app.root, "repeated-write"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    gate.resolve();
    await Promise.allSettled(active);
    await outer.drained();
    await app.close();
  }
});
