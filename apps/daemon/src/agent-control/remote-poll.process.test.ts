import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { expect, test } from "vitest";
import { Client, webSocketTransport } from "@ace/client";
import {
  DeviceId,
  RemoteAgentHost,
  RemoteTask,
  RemoteDelegationResult,
  RemoteAgentOperation,
} from "@ace/protocol";
import { daemonFixture } from "./daemon-test-support.ts";

test("capacity polls keep the client ready and fairly route active work and cancellation reconciliation", async () => {
  const f = await daemonFixture();
  const client = new Client({
    deviceId: DeviceId.parse("capacity-broker"),
    transport: () => webSocketTransport(() => new WebSocket(f.daemon.url)),
    credential: () => readFile(f.daemon.tokenPath, "utf8"),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set(ms, fn) {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    },
    id: randomUUID,
    random: () => 0.5,
  });
  try {
    await client.start();
    await expect.poll(() => client.state).toBe("ready");
    const host = RemoteAgentHost.parse({
      hostId: "target",
      name: "Target",
      projects: [{ workspaceId: "project", name: "Project" }],
      agents: [
        {
          provider: "codex",
          model: "chosen-model",
          permissionModes: [
            {
              id: f.daemon.engine?.permissionMode(f.caller.threadId) ?? ":read-only",
              label: "Safe",
              description: "safe",
              risk: "low",
            },
          ],
        },
      ],
    });
    const registration = await client.request({
      type: "delegation.broker.register",
      hosts: [host],
    });
    if (!registration.lease) throw new Error("Missing lease");
    async function delegate(caller: typeof f.caller, requestId: string) {
      const result = await f.controls.remote.execute(
        caller,
        RemoteAgentOperation.parse({
          op: "device.delegate",
          requestId,
          hostId: "target",
          workspaceId: "project",
          provider: "codex",
          model: "chosen-model",
          role: "Reviewer",
          task: "Review",
        }),
        new AbortController().signal,
      );
      expect(result.ok).toBe(true);
      return RemoteTask.parse(result.data);
    }
    const warning = await delegate(f.caller, "warning");
    await client.request({ type: "delegation.broker.poll", lease: registration.lease });
    f.controls.remote.stopTask(warning.id);
    f.h.clock.advance(f.h.clock.now() + 30000);
    const renewed = await client.request({ type: "delegation.broker.register", hosts: [host] });
    if (!renewed.lease) throw new Error("Missing renewed lease");
    const expected = new Set([warning.id]);
    let cancelling: string | undefined;
    for (let parent = 0; parent < 16; parent++) {
      const created = f.controls.delegations.command(`parent-${parent}`, {
        type: "thread.create",
        workspaceId: f.workspace,
        provider: "codex",
        input: [{ type: "text", text: "Plan" }],
      });
      await f.daemon.engine?.flush();
      const thread = created.threadId && f.daemon.store.getThread(created.threadId);
      if (!thread?.rootAgentId) throw new Error("Missing parent");
      for (let child = 0; child < 4; child++) {
        const task = await delegate(
          { ...f.caller, threadId: thread.id, agentId: thread.rootAgentId },
          `work-${child}`,
        );
        expected.add(task.id);
        cancelling ??= task.id;
      }
    }
    // A dispatched live cancellation must also progress at the capacity boundary.
    const first = await client.request({ type: "delegation.broker.poll", lease: renewed.lease });
    expect(RemoteDelegationResult.safeParse(first).success).toBe(true);
    const seen = new Set(first.tasks?.map((task) => task.id));
    const omitted = [...expected].find((id) => !seen.has(id));
    if (!omitted) throw new Error("Capacity poll did not omit a task");
    if (!cancelling) throw new Error("No live task");
    f.controls.remote.stopTask(cancelling);
    for (let poll = 0; poll < 3; poll++) {
      const reply = await client.request({
        type: "delegation.broker.poll",
        lease: renewed.lease,
        trackedTaskIds: [omitted],
      });
      expect(reply.tasks?.length).toBeLessThanOrEqual(64);
      expect(reply.inactiveTaskIds).toEqual([]);
      for (const task of reply.tasks ?? []) seen.add(task.id);
    }
    expect(seen).toEqual(expected);
    expect(client.state).toBe("ready");
    const subscription = client.thread(f.caller.threadId);
    try {
      await expect.poll(() => subscription.store.thread?.id).toBe(f.caller.threadId);
      f.daemon.store.appendEvents(f.caller.threadId, [
        { type: "thread.updated", title: "Unrelated update after capacity poll" },
      ]);
      await expect
        .poll(() => subscription.store.thread?.title)
        .toBe("Unrelated update after capacity poll");
    } finally {
      subscription.release();
    }
  } finally {
    client.close();
    await f.daemon.close();
  }
});
