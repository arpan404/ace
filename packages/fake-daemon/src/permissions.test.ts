import { expect, test } from "vitest";
import { Client, PermissionClient, permissionReview } from "@ace/client";
import { DeviceId, ThreadId, WorkspaceId } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "./index.ts";
import type { Fact } from "@ace/core";

async function fixture() {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  let id = 0;
  const client = new Client({
    deviceId: DeviceId.parse("permission-test"),
    transport: () => fakeTransport(daemon),
    storage: {
      async load() {
        return null;
      },
      async save() {},
    },
    credential: async () => daemon.token,
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `id-${++id}`,
  });
  const ready = new Promise<void>((resolve) => {
    const stop = client.connectionState().subscribe(() => {
      if (client.state === "ready") {
        stop();
        resolve();
      }
    });
  });
  await client.start();
  await ready;
  return { daemon, client, permissions: new PermissionClient(client) };
}
function approval(command: string): Fact {
  return {
    type: "interaction.opened",
    agent: "root",
    interaction: "approval",
    blocking: true,
    request: {
      kind: "approval",
      title: command,
      target: { tool: "shell", command, access: "execute" },
      options: [
        { id: "once", label: "Once", kind: "allow_once" },
        { id: "no", label: "Deny", kind: "deny" },
      ],
    },
  };
}

test.each([
  ["pwd", "approve", "resolved"],
  ["rm -rf build", "deny", "resolved"],
  ["curl example.com", "escalate", "pending"],
] as const)(
  "fake %s yields the same %s review visible through client readers",
  async (command, decision, state) => {
    const f = await fixture();
    try {
      const created = await f.client.command({
        type: "thread.create",
        workspaceId: WorkspaceId.parse("workspace"),
        provider: "codex",
        input: [{ type: "text", text: "task" }],
      });
      if (!created.threadId) throw new Error("Missing thread");
      f.daemon.apply(created.threadId, [approval(command)]);
      const lease = f.client.thread(created.threadId);
      try {
        const ready = new Promise<void>((resolve) => {
          const selection = lease.store.select(
            ["interactions"],
            (source) => source.interactionIds().length > 0,
          );
          if (selection.getSnapshot()) {
            resolve();
            return;
          }
          const stop = selection.subscribe(() => {
            if (selection.getSnapshot()) {
              stop();
              resolve();
            }
          });
        });
        await ready;
        const id = lease.store.interactionIds()[0];
        if (!id) throw new Error("Missing interaction");
        expect(lease.store.interaction(id)?.state).toBe(state);
        expect(permissionReview(lease.store, id)).toMatchObject({ decision });
        expect(permissionReview(lease.store, id)?.reason.length).toBeGreaterThan(0);
      } finally {
        lease.release();
      }
    } finally {
      await f.client.close();
    }
  },
);

test("client scoped defaults and thread commands preserve an active turn's mode", async () => {
  const f = await fixture();
  try {
    expect((await f.permissions.getDefault()).entries[0]?.value).toBe("auto-review");
    await f.permissions.setDefault("ask", {
      kind: "workspace",
      workspaceId: WorkspaceId.parse("workspace"),
    });
    const created = await f.client.command({
      type: "thread.create",
      workspaceId: WorkspaceId.parse("workspace"),
      provider: "codex",
      input: [{ type: "text", text: "task" }],
    });
    if (!created.threadId) throw new Error("Missing thread");
    await f.permissions.setThread(created.threadId, "full-access");
    const current = f.daemon.snapshot({ kind: "thread", threadId: created.threadId });
    expect(current).toMatchObject({ thread: { permission: { effective: "ask", pending: true } } });
    f.daemon.apply(created.threadId, [{ type: "turn.ended", agent: "root", outcome: "completed" }]);
    await f.client.command({
      type: "thread.send",
      threadId: created.threadId,
      input: [{ type: "text", text: "next" }],
    });
    expect(f.daemon.snapshot({ kind: "thread", threadId: created.threadId })).toMatchObject({
      thread: { permission: { effective: "full-access", pending: false } },
    });
  } finally {
    await f.client.close();
  }
});

test("a fake child cannot widen inherited permissions", async () => {
  const f = await fixture();
  try {
    f.daemon.createThread({
      id: "parent",
      workspaceId: "workspace",
      title: "Parent",
      provider: "codex",
      permissionMode: "read-only",
    });
    f.daemon.createThread({
      id: "child",
      parentThreadId: "parent",
      workspaceId: "workspace",
      title: "Child",
      provider: "codex",
    });
    expect(await f.permissions.setThread("child", "full-access")).toMatchObject({
      ok: false,
      error: "permission_exceeds_parent",
    });
    f.daemon.apply("child", [
      {
        type: "agent.seen",
        agent: "root",
        fidelity: "full",
        origin: "root",
        native: { provider: "codex" },
        cwd: "/fake/workspace",
      },
      { type: "turn.started", agent: "root", trigger: "spawn" },
    ]);
    expect(f.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("child") })).toMatchObject({
      thread: { permission: { effective: "read-only" } },
    });
  } finally {
    await f.client.close();
  }
});
