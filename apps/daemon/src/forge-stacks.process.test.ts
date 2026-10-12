import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { Command, Thread, WorkspaceActionRequest } from "@ace/protocol";
import {
  fakeGh,
  stackChecksFixture,
  stackResponse,
  stackLayers,
  expectedStack,
  stackUuid,
  repository,
  localStack,
  type Fixtures,
} from "@ace/forge/testing";
import type { CommandRequest } from "@ace/forge";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
const execute = promisify(execFile);
const queued = stackLayers.map((pr) => ({
  position: pr.position,
  pullRequest: { ...pr, mergeQueueEntry: pr.number <= 8 ? { state: "AWAITING_CHECKS" } : null },
}));
async function fixture(
  fixtures: Fixtures,
  commandFor: (request: CommandRequest, executable: string) => string = (_request, executable) =>
    executable,
) {
  const root = await mkdtemp(join(tmpdir(), "ace-stacks-"));
  const gh = await fakeGh({
    ...stackChecksFixture,
    ...fixtures,
    "repos/octo/ace/pulls/7": [{ raw: "offline" }],
    "repos/octo/ace/pulls/8": [{ raw: "offline" }],
  });
  const db = join(root, "events.sqlite");
  await execute("git", ["init", root]);
  await execute("git", ["-C", root, "remote", "add", "origin", "https://github.com/octo/ace.git"]);
  let store = new Store(db);
  const workspaceId = store.createWorkspace(root, "Project");
  const thread = Thread.parse({
    id: "stack-thread",
    workspaceId,
    provider: "codex",
    title: "Stack task",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const options = {
    forgeRunner: () => (request: Parameters<typeof gh.runner>[0]) =>
      gh.runner({ ...request, command: commandFor(request, gh.executable) }),
  };
  let runtime = new WorkspaceRuntime(store, root, () => 1000, options);
  await runtime.forge.link(thread.id, root, { repository, number: 7 });
  await runtime.forge.link(thread.id, root, { repository, number: 8 });
  runtime.forge.unlink(thread.id, { repository, number: 7 });
  return {
    gh,
    thread,
    workspaceId,
    get store() {
      return store;
    },
    command(id: string, action: "merge" | "rebase" | "continue" | "abort" | "push" = "merge") {
      return runtime.execute(
        Command.parse({
          id,
          deviceId: "device",
          payload: {
            type: "forge.pr.stack.change",
            link: { threadId: thread.id, pr: { repository, number: 8 } },
            expected: expectedStack,
            action,
            method: "squash",
          },
        }),
      );
    },
    read() {
      return runtime.read(
        WorkspaceActionRequest.parse({
          type: "workspace.request",
          requestId: "stack",
          operation: {
            op: "forge.pr.stack",
            workspaceId,
            repository,
            number: 8,
            threadId: thread.id,
          },
        }),
      );
    },
    async restart() {
      await runtime.close();
      await store.close();
      store = new Store(db);
      runtime = new WorkspaceRuntime(store, root, () => 2000, options);
    },
    async close() {
      await runtime.close();
      await store.close();
      await gh.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("native merge receipts and host UUIDs survive restart, queue ejection refreshes, and an unlinked lower layer stays unlinked", async () => {
  const f = await fixture({
    graphql: [stackResponse(), stackResponse(), stackResponse(8, queued), stackResponse()],
    "stack-view": [{ code: 1 }],
    "repos/octo/ace/pulls/8/merge-async": [
      { body: { status: "pending", details: { uuid: stackUuid, message: "Requested" } } },
    ],
    [`repos/octo/ace/pulls/8/merge-async/${stackUuid}`]: [
      { body: { status: "enqueued", details: { message: "Queued" } } },
    ],
  });
  try {
    const receipt = await f.command("merge");
    expect(receipt).toMatchObject({
      ok: true,
      stackOperation: { state: "pending", uuid: stackUuid },
    });
    await f.restart();
    const before = (await f.gh.requests()).length;
    expect(await f.command("merge")).toEqual(receipt);
    expect((await f.gh.requests()).length).toBe(before);
    expect(await f.read()).toMatchObject({
      result: {
        kind: "forge",
        data: {
          resource: "prStack",
          value: {
            operation: { state: "enqueued" },
            stack: { layers: [{ number: 7 }, { number: 8 }, { number: 9 }] },
          },
        },
      },
    });
    expect(await f.read()).toMatchObject({
      result: {
        kind: "forge",
        data: {
          value: {
            operation: { state: "failed", message: expect.stringContaining("no longer reports") },
          },
        },
      },
    });
    expect(f.store.getThread(f.thread.id)?.details?.linkedPrs?.map((pr) => pr.number)).toEqual([8]);
  } finally {
    await f.close();
  }
});
test("a lost merge acknowledgement remains durable and a new command cannot repeat the uncertain remote write", async () => {
  const f = await fixture({
    graphql: [stackResponse()],
    "stack-view": [{ code: 1 }],
    "repos/octo/ace/pulls/8/merge-async": [{ raw: "acknowledgement lost" }],
  });
  try {
    expect(await f.command("lost")).toMatchObject({ ok: false, error: "forge_invalid_data" });
    await f.restart();
    expect(await f.read()).toMatchObject({
      result: { kind: "forge", data: { value: { operation: { state: "uncertain" } } } },
    });
    expect(await f.command("new-merge")).toMatchObject({ ok: false, error: "forge_conflict" });
    expect(
      (await f.gh.requests()).filter(
        (request) => request.path === "repos/octo/ace/pulls/8/merge-async",
      ),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test("an interrupted local rebase exposes recovery after restart and abort does not publish or relink dependencies", async () => {
  const f = await fixture({
    graphql: [stackResponse()],
    "stack-view": [{ body: localStack }],
    "stack-rebase": [{ code: 3 }],
    "stack-rebase-abort": [{ code: 0 }],
  });
  try {
    expect(await f.command("rebase", "rebase")).toMatchObject({
      ok: true,
      stackOperation: { state: "conflict" },
    });
    await f.restart();
    expect(await f.read()).toMatchObject({
      result: { kind: "forge", data: { value: { operation: { state: "conflict" } } } },
    });
    expect(await f.command("abort", "abort")).toMatchObject({
      ok: true,
      stackOperation: { state: "aborted" },
    });
    expect((await f.gh.requests()).some((request) => request.path === "stack-push")).toBe(false);
    expect(f.store.getThread(f.thread.id)?.details?.linkedPrs?.map((pr) => pr.number)).toEqual([8]);
  } finally {
    await f.close();
  }
});
test("a dissolved native stack still exposes its pending recorded merge result", async () => {
  const missing = {
    body: {
      data: { repository: { viewerPermission: "WRITE", pullRequest: { number: 8, stack: null } } },
    },
  };
  const f = await fixture({
    graphql: [stackResponse(), stackResponse(), missing],
    "stack-view": [{ code: 1 }],
    "repos/octo/ace/pulls/8/merge-async": [
      { body: { status: "pending", details: { uuid: stackUuid, message: "Requested" } } },
    ],
    [`repos/octo/ace/pulls/8/merge-async/${stackUuid}`]: [
      { body: { status: "merged", details: { message: "Merged" } } },
    ],
  });
  try {
    await f.command("merge");
    await f.restart();
    expect(await f.read()).toMatchObject({
      result: { kind: "forge", data: { value: { stack: null, operation: { state: "merged" } } } },
    });
  } finally {
    await f.close();
  }
});

test("a delayed refresh cannot overwrite a newer merge request's durable UUID", async () => {
  const nextUuid = "740b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42";
  const path = `repos/octo/ace/pulls/8/merge-async/${stackUuid}`;
  const f = await fixture({
    graphql: [stackResponse()],
    "stack-view": [{ code: 1 }],
    "repos/octo/ace/pulls/8/merge-async": [
      { body: { status: "pending", details: { uuid: stackUuid, message: "First request" } } },
      { body: { status: "pending", details: { uuid: nextUuid, message: "New request" } } },
    ],
    [path]: [
      {
        barrier: "release-result",
        body: { status: "enqueued", details: { message: "Old result" } },
      },
      { body: { status: "failed", details: { message: "Rejected by GitHub" } } },
    ],
    [`repos/octo/ace/pulls/8/merge-async/${nextUuid}`]: [
      { body: { status: "merged", details: { message: "New request merged" } } },
    ],
  });
  let refresh: ReturnType<typeof f.read> | undefined;
  try {
    await f.command("first");
    refresh = f.read();
    await vi.waitFor(async () =>
      expect((await f.gh.requests()).some((request) => request.path === path)).toBe(true),
    );
    expect(await f.command("retry")).toMatchObject({
      ok: true,
      stackOperation: { state: "pending", uuid: nextUuid },
    });
    await writeFile(join(f.gh.dir, "release-result"), "");
    expect(await refresh).toMatchObject({
      result: {
        kind: "forge",
        data: { value: { operation: { state: "pending", uuid: nextUuid } } },
      },
    });
    await f.restart();
    expect(await f.read()).toMatchObject({
      result: {
        kind: "forge",
        data: { value: { operation: { state: "merged", message: "New request merged" } } },
      },
    });
  } finally {
    await writeFile(join(f.gh.dir, "release-result"), "");
    await refresh?.catch(() => {});
    await f.close();
  }
});

test("a pre-queue host snapshot cannot downgrade a concurrently accepted queue receipt", async () => {
  const f = await fixture({
    graphql: [
      stackResponse(),
      stackResponse(),
      { ...stackResponse(), barrier: "release-snapshot" },
      stackResponse(8, queued),
    ],
    "stack-view": [{ code: 1 }],
    "repos/octo/ace/pulls/8/merge-async": [
      { body: { status: "pending", details: { uuid: stackUuid, message: "Requested" } } },
    ],
    [`repos/octo/ace/pulls/8/merge-async/${stackUuid}`]: [
      { body: { status: "enqueued", details: { message: "Accepted by queue" } } },
    ],
  });
  let oldRefresh: ReturnType<typeof f.read> | undefined;
  try {
    await f.command("merge");
    oldRefresh = f.read();
    await vi.waitFor(async () =>
      expect((await f.gh.requests()).filter((r) => r.path === "graphql")).toHaveLength(3),
    );
    expect(await f.read()).toMatchObject({
      result: { kind: "forge", data: { value: { operation: { state: "enqueued" } } } },
    });
    await writeFile(join(f.gh.dir, "release-snapshot"), "");
    expect(await oldRefresh).toMatchObject({
      result: { kind: "forge", data: { value: { operation: { state: "enqueued" } } } },
    });
    await f.restart();
    expect(await f.read()).toMatchObject({
      result: { kind: "forge", data: { value: { operation: { state: "enqueued" } } } },
    });
  } finally {
    await writeFile(join(f.gh.dir, "release-snapshot"), "");
    await oldRefresh?.catch(() => {});
    await f.close();
  }
});

test.each(["merge", "rebase"] as const)(
  "an unavailable gh before %s dispatch leaves a failed receipt and allows a restored CLI to retry",
  async (action) => {
    let unavailable = true;
    const f = await fixture(
      {
        graphql: [stackResponse()],
        "stack-view": [{ body: localStack }],
        "stack-rebase": [{ code: 0 }],
        "repos/octo/ace/pulls/8/merge-async": [
          { body: { status: "pending", details: { uuid: stackUuid, message: "Requested" } } },
        ],
      },
      (request, executable) => {
        const write =
          request.args.includes("PUT") ||
          (request.args[0] === "stack" && request.args[1] === "rebase");
        if (write && unavailable) {
          unavailable = false;
          return join(executable, "missing-gh");
        }
        return executable;
      },
    );
    try {
      expect(await f.command("not-started", action)).toMatchObject({
        ok: false,
        error: "forge_cli",
      });
      expect(await f.read()).toMatchObject({
        result: {
          kind: "forge",
          data: {
            value: {
              operation: {
                state: "failed",
                message: expect.stringContaining("failed before taking effect"),
              },
            },
          },
        },
      });
      expect(
        (await f.gh.requests()).some((r) => r.args.includes("PUT") || r.path === "stack-rebase"),
      ).toBe(false);
      await f.restart();
      expect(await f.command("not-started", action)).toMatchObject({
        ok: false,
        error: "forge_cli",
      });
      expect(await f.command("restored", action)).toMatchObject({
        ok: true,
        stackOperation: { state: action === "merge" ? "pending" : "push_partial" },
      });
      expect(
        (await f.gh.requests()).filter((r) => r.args.includes("PUT") || r.path === "stack-rebase"),
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);

const queueFacts = (state: string, queue: string | null) => ({
  body: {
    data: {
      repository: {
        pr7: {
          number: 7,
          state,
          isDraft: false,
          mergeQueueEntry: queue ? { state: queue } : null,
        },
        pr8: {
          number: 8,
          state,
          isDraft: false,
          mergeQueueEntry: queue ? { state: queue } : null,
        },
      },
    },
  },
});

test.each([
  ["ejected", "failed"],
  ["merged", "merged"],
  ["unavailable", "uncertain"],
  ["queued", "enqueued"],
] as const)(
  "a recorded queue scope that becomes %s reconciles after native membership disappears",
  async (host, outcome) => {
    const missing = {
      body: {
        data: {
          repository: {
            viewerPermission: "WRITE",
            pullRequest: { number: 8, stack: null },
          },
        },
      },
    };
    const facts =
      host === "unavailable"
        ? { body: { data: { repository: { pr7: null, pr8: null } } } }
        : host === "merged"
          ? queueFacts("MERGED", null)
          : host === "queued"
            ? queueFacts("OPEN", "AWAITING_CHECKS")
            : queueFacts("OPEN", null);
    const f = await fixture({
      graphql: [stackResponse(), stackResponse(), missing],
      "stack-view": [{ code: 1 }],
      "repos/octo/ace/pulls/8/merge-async": [
        { body: { status: "enqueued", details: { uuid: stackUuid, message: "Accepted" } } },
      ],
      [`repos/octo/ace/pulls/8/merge-async/${stackUuid}`]: [
        host === "ejected"
          ? { status: 404, body: { message: "Result expired" } }
          : { body: { status: "enqueued", details: { message: "Historical acceptance" } } },
      ],
      "stack-scope": [facts, queueFacts("OPEN", "AWAITING_CHECKS")],
    });
    try {
      expect(await f.command("merge")).toMatchObject({
        ok: true,
        stackOperation: { state: "enqueued" },
      });
      await f.restart();
      expect(await f.read()).toMatchObject({
        result: {
          kind: "forge",
          data: {
            value: {
              stack: null,
              operation: { state: outcome, uuid: stackUuid },
            },
          },
        },
      });
      if (host === "unavailable") {
        expect(await f.command("blocked")).toMatchObject({ ok: false, error: "forge_conflict" });
        expect(await f.read()).toMatchObject({
          result: {
            kind: "forge",
            data: {
              value: {
                operation: { state: "enqueued" },
              },
            },
          },
        });
      }
      expect((await f.gh.requests()).filter((r) => r.args.includes("PUT"))).toHaveLength(1);
      expect(f.store.getThread(f.thread.id)?.details?.linkedPrs?.map((pr) => pr.number)).toEqual([
        8,
      ]);
    } finally {
      await f.close();
    }
  },
);

test("a native HTTP 409 acknowledgement keeps its existing UUID across restart without resubmission", async () => {
  const f = await fixture({
    graphql: [stackResponse(), stackResponse(), stackResponse(8, queued)],
    "stack-view": [{ code: 1 }],
    "repos/octo/ace/pulls/8/merge-async": [
      {
        status: 409,
        code: 1,
        body: { status: "pending", details: { uuid: stackUuid, message: "Existing request" } },
      },
    ],
    [`repos/octo/ace/pulls/8/merge-async/${stackUuid}`]: [
      { body: { status: "enqueued", details: { message: "Accepted by queue" } } },
    ],
  });
  try {
    expect(await f.command("adopt")).toMatchObject({
      ok: true,
      stackOperation: { state: "pending", uuid: stackUuid },
    });
    await f.restart();
    expect(await f.read()).toMatchObject({
      result: {
        kind: "forge",
        data: { value: { operation: { state: "enqueued", uuid: stackUuid } } },
      },
    });
    expect((await f.gh.requests()).filter((r) => r.args.includes("PUT"))).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test.each([409, 422])(
  "a definite HTTP %s stack merge refusal releases the receipt across restart for a reviewed retry",
  async (status) => {
    const f = await fixture({
      graphql: [stackResponse()],
      "stack-view": [{ code: 1 }],
      "repos/octo/ace/pulls/8/merge-async": [
        { status, code: 1, body: { message: status === 409 ? "Conflict" : "Validation failed" } },
        { body: { status: "pending", details: { uuid: stackUuid, message: "Requested" } } },
      ],
    });
    try {
      expect(await f.command("rejected")).toMatchObject({ ok: false, error: "forge_conflict" });
      expect(await f.read()).toMatchObject({
        result: { kind: "forge", data: { value: { operation: { state: "failed" } } } },
      });
      await f.restart();
      expect(await f.command("retry")).toMatchObject({
        ok: true,
        stackOperation: { state: "pending", uuid: stackUuid },
      });
      expect((await f.gh.requests()).filter((r) => r.args.includes("PUT"))).toHaveLength(2);
    } finally {
      await f.close();
    }
  },
);
