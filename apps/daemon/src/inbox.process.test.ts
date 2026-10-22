import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { CommandRequest, CommandRunner } from "@ace/forge";
import { fakeGh, type Fixtures } from "@ace/forge/testing";
import { Command, type ForgeInboxWrite } from "@ace/protocol";
import { readErrorCode } from "./action-errors.ts";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const execute = promisify(execFile);
const firstPage = "notifications?all=false&participating=false&per_page=50&page=1";
const review = {
  id: "41",
  unread: true,
  reason: "review_requested",
  updated_at: "2026-10-22T09:00:00Z",
  last_read_at: null,
  subject: {
    title: "Retry flaky uploads",
    url: "https://api.github.com/repos/octo/ace/pulls/7",
    type: "PullRequest",
  },
  repository: { name: "ace", owner: { login: "octo" } },
};

async function environment(
  records: Fixtures,
  transform?: (request: CommandRequest, run: CommandRunner) => ReturnType<CommandRunner>,
) {
  const gh = await fakeGh(records);
  const root = await mkdtemp(join(tmpdir(), "ace-inbox-"));
  await execute("git", ["init", "-q", root]);
  await execute("git", ["-C", root, "remote", "add", "origin", "https://github.com/octo/ace.git"]);
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const runtime = new WorkspaceRuntime(store, root, () => 1000, {
    forgeRunner: () => (request) =>
      transform
        ? transform(request, (next) => gh.runner({ ...next, command: gh.executable }))
        : gh.runner({ ...request, command: gh.executable }),
  });
  return {
    gh,
    list() {
      return runtime.read({
        type: "workspace.request",
        requestId: "inbox",
        operation: {
          op: "forge.inbox.list",
          workspaceId,
          query: { all: false, participating: false, page: 1 },
        },
      });
    },
    write(id: string, input: ForgeInboxWrite, allowed: () => boolean = () => true) {
      return runtime.execute(
        Command.parse({
          id,
          deviceId: "device",
          payload: { type: "forge.inbox.write", workspaceId, input },
        }),
        allowed,
      );
    },
    async cleanup() {
      await runtime.close();
      await store.close();
      await gh.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a project's inbox lists notifications on its GitHub host, and marking one done reaches GitHub", async () => {
  const env = await environment({
    [firstPage]: [{ body: [review] }],
    "graphql:InboxStates": [
      { body: { data: { r0: { n7: { __typename: "PullRequest", state: "OPEN" } } } } },
    ],
    "notifications/threads/41": [{ status: 204, raw: "" }],
  });
  try {
    const reply = await env.list();
    expect(reply.result).toMatchObject({
      kind: "forge",
      data: {
        resource: "inboxList",
        value: {
          host: "github.com",
          items: [{ id: "41", reason: "review_requested", number: 7, state: "open" }],
        },
      },
    });
    expect(await env.write("done-41", { action: "done", id: "41" })).toMatchObject({
      ok: true,
      inboxAction: { id: "done-41", state: "succeeded", action: "done" },
    });
    const sent = (await env.gh.requests()).find((r) => r.path === "notifications/threads/41");
    expect(sent?.args).toContain("DELETE");
  } finally {
    await env.cleanup();
  }
});

test("a read the token can't make is answered with the notifications category", async () => {
  const env = await environment({
    [firstPage]: [{ status: 403, body: { message: "Resource not accessible by integration" } }],
  });
  try {
    const error: unknown = await env.list().catch((caught: unknown) => caught);
    expect(readErrorCode("forge.inbox.list", error)).toBe("forge_notifications_unavailable");
  } finally {
    await env.cleanup();
  }
});

test("a write GitHub refused failed, and one whose answer was lost is uncertain and not retried", async () => {
  const env = await environment(
    {
      "notifications/threads/1": [{ status: 403, body: { message: "Forbidden" } }],
      "notifications/threads/2": [{ status: 205, raw: "" }],
    },
    async (request, run) => {
      const output = await run(request);
      // The process ran, but its answer never came back.
      return request.args[1] === "notifications/threads/2"
        ? { code: 1, stdout: "", truncated: false }
        : output;
    },
  );
  try {
    expect(await env.write("refused", { action: "read", id: "1" })).toMatchObject({
      ok: false,
      error: "forge_notifications_unavailable",
      inboxAction: { state: "failed", error: "forge_notifications_unavailable" },
    });
    expect(await env.write("lost", { action: "read", id: "2" })).toMatchObject({
      ok: false,
      error: "action_outcome_uncertain",
      inboxAction: { state: "uncertain" },
    });
    const sent = (await env.gh.requests()).filter((r) => r.path === "notifications/threads/2");
    expect(sent).toHaveLength(1);
  } finally {
    await env.cleanup();
  }
});

test("a device that loses its authority before dispatch sends nothing", async () => {
  const env = await environment({ "notifications/threads/3": [{ status: 205, raw: "" }] });
  try {
    let checks = 0;
    const result = await env.write("revoked", { action: "unsubscribe", id: "3" }, () => {
      checks++;
      return checks < 2;
    });
    expect(result).toMatchObject({ ok: false, inboxAction: { state: "failed" } });
    const sent = await env.gh.requests().catch(() => []);
    expect(sent.filter((r) => r.path.startsWith("notifications/threads/3"))).toHaveLength(0);
  } finally {
    await env.cleanup();
  }
});

test("a replayed command is answered from its receipt and never reaches GitHub twice", async () => {
  const env = await environment({ "notifications/threads/7": [{ status: 204, raw: "" }] });
  try {
    const first = await env.write("replayed", { action: "done", id: "7" });
    expect(first).toMatchObject({ ok: true, inboxAction: { state: "succeeded" } });
    // The client lost the answer and sends the same command again on reconnect.
    expect(await env.write("replayed", { action: "done", id: "7" })).toEqual(first);
    const sent = (await env.gh.requests()).filter((r) => r.path === "notifications/threads/7");
    expect(sent).toHaveLength(1);
  } finally {
    await env.cleanup();
  }
});

test("the inbox names the project's own repository, so its rows open without naming it", async () => {
  const env = await environment({ [firstPage]: [{ body: [review] }] });
  try {
    expect((await env.list()).result).toMatchObject({
      kind: "forge",
      data: {
        resource: "inboxList",
        value: {
          projectRepository: { forge: "github", host: "github.com", owner: "octo", name: "ace" },
        },
      },
    });
  } finally {
    await env.cleanup();
  }
});
